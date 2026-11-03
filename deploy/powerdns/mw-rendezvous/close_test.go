package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// The word that a browser left reaches its host a moment late, and not at all
// when the host's own line goes in the meantime: a restart of the proxy in
// front of this server closes the browsers' sockets and the hosts' lines
// together, and a host told "the browser left" in between took down a tunnel
// that was still good.

// joinPeer connects a browser to idA and reads the open and ready frames.
func joinPeer(t *testing.T, ts string, host *testClient) (*testClient, string) {
	t.Helper()
	peer, _ := dialWS(t, ts, "/v1/peer?id="+idA, nil)
	t.Cleanup(peer.Close)
	var open hostFrame
	host.ReadJSON(t, &open)
	if open.T != msgOpen {
		t.Fatalf("host got %+v, want an open frame", open)
	}
	var ready peerFrame
	peer.ReadJSON(t, &ready)
	if ready.T != msgReady {
		t.Fatalf("peer got %+v, want ready", ready)
	}
	return peer, open.S
}

func TestBrowserLeavingReachesTheHostAfterTheDelay(t *testing.T) {
	s, ts := testServer(t) // maxSessions = 2
	s.cfg.closeDelay = 300 * time.Millisecond
	host := claimAndConnect(t, s, ts, tokenA, idA)

	first, firstID := joinPeer(t, ts.URL, host)
	joinPeer(t, ts.URL, host)

	left := time.Now()
	first.Close()

	// The slot is free at once: a third browser gets in before the host has
	// heard anything about the first.
	waitFor(t, func() bool { return s.hub.sessionCount() == 1 })
	joinPeer(t, ts.URL, host)

	var f hostFrame
	host.ReadJSON(t, &f)
	if f.T != msgClose || f.S != firstID {
		t.Fatalf("host got %+v, want the close for %s", f, firstID)
	}
	if waited := time.Since(left); waited < s.cfg.closeDelay {
		t.Fatalf("close arrived after %s, before the %s delay", waited, s.cfg.closeDelay)
	}
}

func TestHostLineGoingWithinTheDelayHearsNoClose(t *testing.T) {
	s, ts := testServer(t)
	s.cfg.closeDelay = 300 * time.Millisecond
	host := claimAndConnect(t, s, ts, tokenA, idA)
	stale := s.hub.line(idA)

	peer, _ := joinPeer(t, ts.URL, host)
	peer.Close()
	waitFor(t, func() bool { return stale.sessionCount() == 0 })

	// The line goes before the delay is out, and the host comes back on a new
	// one — the way it does after the proxy restarted.
	second, status := dialWS(t, ts.URL, "/v1/host?id="+idA, map[string]string{"X-MW-Owner": tokenA})
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("reconnect: status %d", status)
	}
	t.Cleanup(second.Close)
	waitFor(t, func() bool { return s.hub.line(idA) != stale })
	time.Sleep(2 * s.cfg.closeDelay)

	// The next thing the new line hears is a new browser, not a stale close.
	newcomer, _ := dialWS(t, ts.URL, "/v1/peer?id="+idA, nil)
	t.Cleanup(newcomer.Close)
	var f hostFrame
	second.ReadJSON(t, &f)
	if f.T != msgOpen {
		t.Fatalf("new line got %+v, want an open frame", f)
	}
}

func TestHealthzCountsBrowserSessions(t *testing.T) {
	s, ts := testServer(t)
	host := claimAndConnect(t, s, ts, tokenA, idA)

	health := func() map[string]any {
		resp, err := http.Get(ts.URL + "/healthz")
		if err != nil {
			t.Fatalf("healthz: %v", err)
		}
		defer resp.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return body
	}

	if h := health(); h["online"] != float64(1) || h["sessions"] != float64(0) {
		t.Fatalf("healthz = %v, want 1 online and 0 sessions", h)
	}
	joinPeer(t, ts.URL, host)
	if h := health(); h["sessions"] != float64(1) {
		t.Fatalf("healthz = %v, want 1 session", h)
	}
}
