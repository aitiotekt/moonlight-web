// Identifiers, the ownership claim store, and the per-IP budget.
//
// The claim model is lifted from mw-proxy: Trust On First Use, with only
// HMAC_S(token) on disk so a leak of the file yields no usable credential. It is
// a SEPARATE store with a SEPARATE secret, on purpose — the mw-proxy token
// authorises a DNS zone claim and dies with the sub-domain mechanism in February
// 2027, while this one authorises a rendezvous line. Recycling one token for both
// would merge two unrelated authorisations and outlive the one that should end.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ── Identifiers ─────────────────────────────────────────────────────────────

// idLength is 26 Crockford base32 characters: 130 bits of encoding space over
// the 128 bits of randomness §2.3 calls for. Long because the id is a locator
// that anyone may hold — the pairing signature is what grants access — and
// short identifiers are enumerable.
const idLength = 26

// Crockford's alphabet minus its four ambiguous letters (i, l, o, u), so an id
// survives being read aloud or copied off a screen.
var idPattern = regexp.MustCompile(`^[0-9abcdefghjkmnpqrstvwxyz]{26}$`)

// normaliseID folds the forms a human might produce back to canonical form:
// case, grouping hyphens, and the digit/letter pairs Crockford calls out. The
// host and the browser must apply exactly this function, or a claim made in one
// form would never be found again in another.
func normaliseID(raw string) string {
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		switch r {
		case '-', ' ':
			continue
		case 'i', 'l':
			b.WriteRune('1')
		case 'o':
			b.WriteRune('0')
		case 'u':
			b.WriteRune('v')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func validID(id string) bool { return idPattern.MatchString(id) }

// minOwnerToken rejects a token short enough to be guessed. The host generates
// 256 bits; anything under 32 characters is not something this service issued.
const minOwnerToken = 32

// ── Claim store ─────────────────────────────────────────────────────────────

type claim struct {
	Owner   string `json:"owner"`   // hex(HMAC_S(owner token))
	Created int64  `json:"created"` // unix seconds
	// When a host last held its line on it, unix seconds, to the hour (touch);
	// 0 = never. An id nobody ever held a line on is what a flood of claims
	// leaves behind, and it is let go of after unusedTTL.
	Seen int64 `json:"seen,omitempty"`
}

// touchEvery is how stale Seen may get: a line held again within the hour
// changes nothing on disk.
const touchEvery = time.Hour

// pruneEvery bounds how often a new claim pays for the walk that drops unused
// ids.
const pruneEvery = time.Minute

type claimStore struct {
	mu     sync.Mutex
	path   string
	secret []byte
	claims map[string]claim // id → claim

	// Set after newClaimStore; zero values keep the store as it always was —
	// unbounded, nothing expires, every flush written at once.
	maxClaims int           // new claims refused past this many ids; 0 = no cap
	unusedTTL time.Duration // an id never held a line on is dropped after this; 0 = kept
	delay     time.Duration // flush() coalesces writes over this; 0 = synchronous

	lastPrune time.Time
	dirty     bool
	scheduled bool
	// Held across a whole write, snapshot included, so two writes can never
	// land in the reverse order of the states they took.
	writeMu sync.Mutex
}

func newClaimStore(path string, secret []byte) (*claimStore, error) {
	s := &claimStore{path: path, secret: secret, claims: map[string]claim{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var on struct {
		Claims map[string]claim `json:"claims"`
		Seen   bool             `json:"seenTracked"`
	}
	if err := json.Unmarshal(data, &on); err != nil {
		return nil, err
	}
	if on.Claims != nil {
		s.claims = on.Claims
	}
	// A file from before Seen was kept: every id on it was claimed by a host
	// that may well hold its line, and none may be taken for an unused one.
	if !on.Seen {
		now := time.Now().Unix()
		for id, c := range s.claims {
			c.Seen = now
			s.claims[id] = c
		}
	}
	return s, nil
}

// fingerprint derives the non-reversible owner marker kept on disk.
func (s *claimStore) fingerprint(token string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(token))
	return hex.EncodeToString(mac.Sum(nil))
}

// write persists the store atomically, if anything changed since the last
// write. Takes s.mu for the snapshot only: the disk is written outside it, so a
// host's handshake (owns) never waits on a file being rewritten.
func (s *claimStore) write() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	s.mu.Lock()
	s.scheduled = false
	if !s.dirty {
		s.mu.Unlock()
		return nil
	}
	body, err := json.MarshalIndent(struct {
		Claims map[string]claim `json:"claims"`
		Seen   bool             `json:"seenTracked"`
	}{s.claims, true}, "", "  ")
	s.dirty = err != nil
	s.mu.Unlock()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		s.markDirty()
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		s.markDirty()
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		s.markDirty()
		return err
	}
	return nil
}

// markDirty records that the file is behind, after a write that failed.
func (s *claimStore) markDirty() {
	s.mu.Lock()
	s.dirty = true
	s.mu.Unlock()
}

// pruneLocked drops the ids nobody ever held a line on, once they are older
// than unusedTTL. Caller holds s.mu.
func (s *claimStore) pruneLocked(now time.Time) {
	if s.unusedTTL <= 0 || now.Sub(s.lastPrune) < pruneEvery {
		return
	}
	s.lastPrune = now
	cut := now.Add(-s.unusedTTL).Unix()
	dropped := 0
	for id, c := range s.claims {
		if c.Seen == 0 && c.Created < cut {
			delete(s.claims, id)
			dropped++
		}
	}
	if dropped > 0 {
		s.dirty = true
	}
}

// Outcomes of a claim attempt.
type claimResult int

const (
	claimCreated  claimResult = iota // first ever writer of this id
	claimExisting                    // same owner re-presenting an id it holds
	claimTaken                       // someone else owns this id
	claimHasOther                    // this owner already holds a different id
	claimFull                        // the store holds maxClaims ids already
)

// claim records ownership of id for token, or reports why it cannot.
//
// The whole operation runs under one lock. mw-proxy's equivalent releases the
// lock between validation and commit because it must forward to PowerDNS in
// between, which leaves a window where two owners both pass validation; there is
// no upstream here, so that window simply does not need to exist.
func (s *claimStore) claim(id, token string) claimResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	fp := s.fingerprint(token)
	if existing, ok := s.claims[id]; ok {
		if subtle.ConstantTimeCompare([]byte(existing.Owner), []byte(fp)) == 1 {
			return claimExisting
		}
		return claimTaken
	}
	// One line per owner: without this a single token could reserve identifiers
	// in bulk, and the per-IP budget alone would not stop a patient caller.
	for other, c := range s.claims {
		if other != id && subtle.ConstantTimeCompare([]byte(c.Owner), []byte(fp)) == 1 {
			return claimHasOther
		}
	}
	// Bounded, so a flood of new identifiers stops at a size this container
	// holds, instead of growing until it is killed and restarts in a loop. The
	// ids hosts hold are untouched by it; only new ones wait.
	now := time.Now()
	s.pruneLocked(now)
	if s.maxClaims > 0 && len(s.claims) >= s.maxClaims {
		return claimFull
	}
	s.claims[id] = claim{Owner: fp, Created: now.Unix()}
	s.dirty = true
	return claimCreated
}

// touch records that a host holds its line on id, to the hour: what keeps an
// id from being let go of as unused.
func (s *claimStore) touch(id string) {
	s.mu.Lock()
	c, ok := s.claims[id]
	now := time.Now().Unix()
	if !ok || now-c.Seen < int64(touchEvery/time.Second) {
		s.mu.Unlock()
		return
	}
	c.Seen = now
	s.claims[id] = c
	s.dirty = true
	s.mu.Unlock()
	if err := s.flush(); err != nil {
		log.Printf("[mw-rendezvous] WARN cannot persist claim store: %v", err)
	}
}

// owns reports whether token is the owner of id. Used on every host handshake.
func (s *claimStore) owns(id, token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.claims[id]
	if !ok {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(existing.Owner), []byte(s.fingerprint(token))) == 1
}

// release drops a claim, letting a reinstalled host take a fresh id without an
// operator having to edit the store by hand. Only the owner may do it.
func (s *claimStore) release(id, token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.claims[id]
	if !ok {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(existing.Owner), []byte(s.fingerprint(token))) != 1 {
		return false
	}
	delete(s.claims, id)
	s.dirty = true
	return true
}

func (s *claimStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.claims)
}

// flush persists the current state; callers use it after a mutating operation.
// With a delay, the writes of a burst of claims are one write, made that long
// after the first of them: rewriting the whole file for each one is what let a
// flood of claims slow every host's handshake down. A claim lost to a crash in
// between is made again by its host, the next time it connects.
func (s *claimStore) flush() error {
	if s.delay <= 0 {
		return s.write()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.scheduled {
		s.scheduled = true
		time.AfterFunc(s.delay, func() {
			if err := s.write(); err != nil {
				log.Printf("[mw-rendezvous] WARN cannot persist claim store: %v", err)
			}
		})
	}
	return nil
}

// ── Per-IP budget (sliding window) ──────────────────────────────────────────

// Sweep thresholds, matching mw-proxy: without them the map is append-only, one
// entry per distinct address kept for the life of the process.
const (
	quotaSweepEvery   = 15 * time.Minute
	quotaSweepEntries = 4096
)

type quota struct {
	mu        sync.Mutex
	max       int
	window    time.Duration
	bits      int // the IPv6 prefix an attempt is charged to (quotaKeyBits)
	hits      map[string][]time.Time
	lastSweep time.Time
}

func newQuota(max int, window time.Duration) *quota {
	return newQuotaBits(max, window, 64)
}

func newQuotaBits(max int, window time.Duration, bits int) *quota {
	return &quota{max: max, window: window, bits: bits, hits: map[string][]time.Time{},
		lastSweep: time.Now()}
}

// sweep drops every address whose attempts have all aged out. Caller holds q.mu.
func (q *quota) sweep(now time.Time) {
	cut := now.Add(-q.window)
	for ip, ts := range q.hits {
		live := ts[:0]
		for _, t := range ts {
			if t.After(cut) {
				live = append(live, t)
			}
		}
		if len(live) == 0 {
			delete(q.hits, ip)
			continue
		}
		q.hits[ip] = live
	}
	q.lastSweep = now
}

// quotaKey is what an address's attempts are charged to. An IPv6 subscriber is
// handed a whole /64 at the least, so keying on the full address would give one
// household 2^64 fresh budgets; the /64 is what an IPv4 address is to an ISP —
// one subscriber. An IPv4 address that arrives mapped (::ffff:a.b.c.d) is that
// IPv4 address. Brackets and a port are tolerated; anything unparsable is used
// as it is.
func quotaKey(addr string) string { return quotaKeyBits(addr, 64) }

// quotaKeyBits is quotaKey with the IPv6 prefix it charges: 48 is what a
// tunnel broker hands out for free, 65 536 /64s in one.
func quotaKeyBits(addr string, bits int) string {
	s := strings.TrimSpace(addr)
	a, err := netip.ParseAddr(strings.Trim(s, "[]"))
	if err != nil {
		ap, perr := netip.ParseAddrPort(s)
		if perr != nil {
			return s
		}
		a = ap.Addr()
	}
	a = a.WithZone("").Unmap()
	if a.Is4() {
		return a.String()
	}
	p, _ := a.Prefix(bits)
	return p.String()
}

// allow records an attempt for ip and reports whether it fits the budget.
// A max of 0 disables the quota.
func (q *quota) allow(ip string) bool {
	if q.max <= 0 {
		return true
	}
	ip = quotaKeyBits(ip, q.bits)
	q.mu.Lock()
	defer q.mu.Unlock()
	now := time.Now()
	if now.Sub(q.lastSweep) >= quotaSweepEvery || len(q.hits) >= quotaSweepEntries {
		q.sweep(now)
	}
	cut := now.Add(-q.window)
	kept := q.hits[ip][:0]
	for _, t := range q.hits[ip] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= q.max {
		q.hits[ip] = kept
		return false
	}
	q.hits[ip] = append(kept, now)
	return true
}
