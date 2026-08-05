import { afterEach, describe, expect, it, vi } from "vitest";

// Imported relatively on purpose: platform/patch-exit-check.sh copies this file
// into a clean upstream worktree to decide whether the patch can be dropped, and
// a workspace-package import ("@paperclipai/adapter-codex-local/server") would
// resolve back through the borrowed node_modules to the patched source and pass
// no matter what upstream does.
import { fetchCodexQuota, mapCodexRpcQuota } from "./quota.js";

// ---------------------------------------------------------------------------
// Window labels follow the duration the provider reports, not the slot the
// window arrived in. Which windows exist is a plan detail OpenAI changes.
// ---------------------------------------------------------------------------

describe("codex quota window labels (RPC)", () => {
  // Captured from a live account/rateLimits/read on a Plus account: one 7d
  // window in the `primary` slot, no `secondary` at all. Naming by slot reported
  // it as "5h limit" resetting six days out.
  it("labels a 7d primary window as weekly when secondary is absent", () => {
    const snapshot = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 23, windowDurationMins: 10_080, resetsAt: 1_786_343_012 },
        secondary: null,
        planType: "plus",
      },
    });

    expect(snapshot.windows).toEqual([
      {
        label: "Weekly limit",
        usedPercent: 23,
        resetsAt: "2026-08-10T06:23:32.000Z",
        valueLabel: null,
        detail: null,
      },
    ]);
  });

  it("still labels a 5h primary and 7d secondary correctly", () => {
    const snapshot = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 1, windowDurationMins: 300 },
        secondary: { usedPercent: 27, windowDurationMins: 10_080 },
      },
    });

    expect(snapshot.windows.map((w) => w.label)).toEqual(["5h limit", "Weekly limit"]);
  });

  it("labels an unusually long window descriptively", () => {
    const snapshot = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 5, windowDurationMins: 43_200 },
      },
    });

    expect(snapshot.windows[0]!.label).toBe("30d limit");
  });

  it("falls back to the slot name when the RPC omits windowDurationMins", () => {
    const snapshot = mapCodexRpcQuota({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 5 },
        secondary: { usedPercent: 40 },
      },
    });

    expect(snapshot.windows.map((w) => w.label)).toEqual(["5h limit", "Weekly limit"]);
  });
});

describe("codex quota window labels (WHAM)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response),
    );
  }

  it("labels a weekly primary_window as weekly", async () => {
    mockFetch({
      rate_limit: {
        primary_window: { used_percent: 23, limit_window_seconds: 604800 },
      },
    });

    const windows = await fetchCodexQuota("token", null);
    expect(windows.map((w) => w.label)).toEqual(["Weekly limit"]);
  });

  it("labels a 24h primary_window by its duration", async () => {
    mockFetch({
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 86400 },
      },
    });

    const windows = await fetchCodexQuota("token", null);
    expect(windows.map((w) => w.label)).toEqual(["24h limit"]);
  });

  it("falls back to the slot name when WHAM omits the window duration", async () => {
    mockFetch({
      rate_limit: {
        primary_window: { used_percent: 10 },
        secondary_window: { used_percent: 60 },
      },
    });

    const windows = await fetchCodexQuota("token", null);
    expect(windows.map((w) => w.label)).toEqual(["5h limit", "Weekly limit"]);
  });
});
