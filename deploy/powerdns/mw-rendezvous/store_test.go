package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The flood bounds of the claim store ───────────────────────────────────────

func claimFromAddr(t *testing.T, url, xff, token, id string) int {
	t.Helper()
	body, _ := json.Marshal(claimRequest{ID: id})
	req, _ := http.NewRequest(http.MethodPost, url+"/v1/claim", bytes.NewReader(body))
	req.Header.Set("X-MW-Owner", token)
	req.Header.Set("X-Forwarded-For", xff)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// A free /48 is 65 536 /64s: walking through them must not buy new budget.
func TestClaimBudgetCoversTheWholeSlash48(t *testing.T) {
	s, ts := testServer(t)
	s.claimQuota48 = newQuotaBits(1, time.Hour, 48)
	if status := claimFromAddr(t, ts.URL, "2001:db8:1:2::1", tokenA, idA); status != http.StatusOK {
		t.Fatalf("first claim of the /48: status %d", status)
	}
	if status := claimFromAddr(t, ts.URL, "2001:db8:1:ff::1", tokenB, idB); status != http.StatusTooManyRequests {
		t.Fatalf("another /64 of the same /48: status %d, want 429", status)
	}
}

// Many /48s still meet the server's own budget; an id already held never does.
func TestServerWideClaimBudget(t *testing.T) {
	s, ts := testServer(t)
	s.claimQuotaAll = newQuota(1, time.Hour)
	if status := claimFromAddr(t, ts.URL, "198.51.100.1", tokenA, idA); status != http.StatusOK {
		t.Fatalf("first claim: status %d", status)
	}
	if status := claimFromAddr(t, ts.URL, "203.0.113.9", tokenB, idB); status != http.StatusTooManyRequests {
		t.Fatalf("a second new claim from elsewhere: status %d, want 429", status)
	}
	if status := claimFromAddr(t, ts.URL, "203.0.113.9", tokenA, idA); status != http.StatusOK {
		t.Fatalf("re-claim under an exhausted server budget: status %d, want 200", status)
	}
}

func TestFullStoreRefusesNewIdsOnly(t *testing.T) {
	s, ts := testServer(t)
	s.store.maxClaims = 1
	if status, _ := postClaim(t, ts, http.MethodPost, tokenA, idA); status != http.StatusOK {
		t.Fatalf("first claim: %d", status)
	}
	if status, _ := postClaim(t, ts, http.MethodPost, tokenB, idB); status != http.StatusTooManyRequests {
		t.Fatalf("a new id past the cap: status %d, want 429", status)
	}
	if status, _ := postClaim(t, ts, http.MethodPost, tokenA, idA); status != http.StatusOK {
		t.Fatalf("the owner re-presenting its id at the cap: status %d, want 200", status)
	}
}

// An id nobody ever held a line on goes after unusedTTL; one a host held stays.
func TestUnusedIdIsLetGoOf(t *testing.T) {
	store, _ := newClaimStore(filepath.Join(t.TempDir(), "s.json"), []byte("k"))
	store.unusedTTL = time.Hour
	old := time.Now().Add(-2 * time.Hour).Unix()
	store.claims[idA] = claim{Owner: "x", Created: old}
	store.claims[idB] = claim{Owner: "y", Created: old, Seen: old}
	// A third id: the prune runs on the way to creating one.
	store.claim("zyxwvtsrqpnmkjhgfedcba9876", "3333333333333333333333333333333333333333333333333333333333333333")
	if _, ok := store.claims[idA]; ok {
		t.Fatal("an id no line was ever held on outlived unusedTTL")
	}
	if _, ok := store.claims[idB]; !ok {
		t.Fatal("an id a host held its line on was let go of")
	}
}

func TestTouchMarksAnIdInUse(t *testing.T) {
	store, _ := newClaimStore(filepath.Join(t.TempDir(), "s.json"), []byte("k"))
	if store.claim(idA, tokenA) != claimCreated {
		t.Fatal("claim")
	}
	store.touch(idA)
	if store.claims[idA].Seen == 0 {
		t.Fatal("a held line left Seen at 0")
	}
}

// A file written before Seen was kept: every id on it may be a host's.
func TestOlderFileKeepsEveryId(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.json")
	old := time.Now().Add(-30 * 24 * time.Hour).Unix()
	body, _ := json.Marshal(map[string]any{"claims": map[string]claim{idA: {Owner: "x", Created: old}}})
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := newClaimStore(path, []byte("k"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	store.unusedTTL = 24 * time.Hour
	store.claim(idB, tokenB)
	if _, ok := store.claims[idA]; !ok {
		t.Fatal("an id from a file older than Seen was let go of as unused")
	}
}

// Writes are coalesced, and still land.
func TestDelayedFlushLands(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.json")
	store, _ := newClaimStore(path, []byte("k"))
	store.delay = 20 * time.Millisecond
	store.claim(idA, tokenA)
	if err := store.flush(); err != nil {
		t.Fatal(err)
	}
	store.claim(idB, tokenB)
	if err := store.flush(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		reloaded, err := newClaimStore(path, []byte("k"))
		return err == nil && len(reloaded.claims) == 2
	})
}
