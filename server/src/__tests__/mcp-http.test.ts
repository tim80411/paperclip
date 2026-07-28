import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMcpMissingSessionResponse,
  MCP_HTTP_ACCEPT,
  MCP_HTTP_PROTOCOL_VERSION,
  mcpHttpOpenSession,
  mcpHttpRequestHeaders,
  parseMcpHttpResponseBody,
} from "../services/mcp-http.js";

describe("mcpHttpRequestHeaders", () => {
  it("advertises both JSON and SSE on every request", () => {
    expect(mcpHttpRequestHeaders()).toMatchObject({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    expect(MCP_HTTP_ACCEPT).toBe("application/json, text/event-stream");
  });

  it("preserves caller-supplied headers while keeping the required Accept value", () => {
    expect(mcpHttpRequestHeaders({ Authorization: "Bearer x", accept: "application/json" })).toMatchObject({
      accept: "application/json, text/event-stream",
      Authorization: "Bearer x",
    });
  });
});

describe("parseMcpHttpResponseBody", () => {
  it("parses a plain application/json body", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [] } };
    expect(parseMcpHttpResponseBody(JSON.stringify(payload), "application/json")).toEqual(payload);
  });

  it("parses an SSE-framed body, extracting the JSON-RPC message", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [{ name: "kv_get" }] } };
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream; charset=utf-8")).toEqual(payload);
  });

  it("skips non-JSON-RPC SSE events and returns the response message", () => {
    const ping = "event: ping\ndata: {\"type\":\"ping\"}";
    const message = { jsonrpc: "2.0", id: "1", result: { ok: true } };
    const body = `${ping}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(message);
  });

  it("handles multi-line SSE data fields", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { note: "line" } };
    const json = JSON.stringify(payload, null, 2);
    const body = `data: ${json.split("\n").join("\ndata: ")}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(payload);
  });

  it("throws when an SSE stream carries no data events", () => {
    expect(() => parseMcpHttpResponseBody("event: ping\n\n", "text/event-stream")).toThrow();
  });
});

describe("isMcpMissingSessionResponse", () => {
  it("recognises the reference transport's missing-session rejection", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    expect(isMcpMissingSessionResponse(400, body)).toBe(true);
  });

  it("falls back to the error code paired with a session mention", () => {
    expect(isMcpMissingSessionResponse(400, '{"error":{"code":-32000,"message":"Session expired"}}')).toBe(true);
  });

  it("leaves other statuses alone so auth challenges keep their own handling", () => {
    expect(isMcpMissingSessionResponse(401, "No valid session ID provided")).toBe(false);
    expect(isMcpMissingSessionResponse(403, "No valid session ID provided")).toBe(false);
  });

  it("ignores unrelated 400s and empty bodies", () => {
    expect(isMcpMissingSessionResponse(400, '{"error":{"code":-32600,"message":"Invalid Request"}}')).toBe(false);
    expect(isMcpMissingSessionResponse(400, "")).toBe(false);
  });
});

describe("mcpHttpOpenSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(...responses: Array<Response | Error>) {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    let index = 0;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next.clone());
    });
    return calls;
  }

  it("returns the issued session header and sends the initialized notification", async () => {
    const calls = stubFetch(
      new Response("{}", { status: 200, headers: { "mcp-session-id": "session-1" } }),
      new Response("", { status: 202 }),
    );

    const session = await mcpHttpOpenSession({
      endpoint: "https://mcp.example/mcp",
      clientVersion: "1.2.3",
      headers: { Authorization: "Bearer token" },
    });

    expect(session).toEqual({ headers: { "mcp-session-id": "session-1" }, stateless: false });
    const [initializeCall, notificationCall] = calls;
    expect(calls).toHaveLength(2);
    expect(initializeCall?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: MCP_HTTP_PROTOCOL_VERSION,
        clientInfo: { name: "paperclip", version: "1.2.3" },
      },
    });
    expect(initializeCall?.headers).toMatchObject({ Authorization: "Bearer token" });
    expect(notificationCall?.body).toMatchObject({ method: "notifications/initialized" });
    expect(notificationCall?.headers).toMatchObject({ "mcp-session-id": "session-1" });
  });

  it("reports a stateless server when no session id is issued", async () => {
    const calls = stubFetch(new Response("{}", { status: 200 }));

    await expect(
      mcpHttpOpenSession({ endpoint: "https://mcp.example/mcp", clientVersion: "1.2.3" }),
    ).resolves.toEqual({ headers: {}, stateless: true });
    expect(calls).toHaveLength(1);
  });

  it("returns null when initialize is rejected, leaving the caller's handling in charge", async () => {
    const calls = stubFetch(new Response("missing token", { status: 401 }));

    await expect(
      mcpHttpOpenSession({ endpoint: "https://mcp.example/mcp", clientVersion: "1.2.3" }),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when the request itself fails", async () => {
    stubFetch(new Error("connect ECONNREFUSED"));

    await expect(
      mcpHttpOpenSession({ endpoint: "https://mcp.example/mcp", clientVersion: "1.2.3" }),
    ).resolves.toBeNull();
  });
});
