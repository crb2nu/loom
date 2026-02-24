import { EventEmitter } from "events";

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHttpRequest = vi.hoisted(() => vi.fn());
const mockHttpsRequest = vi.hoisted(() => vi.fn());

vi.mock("http", () => ({
  request: mockHttpRequest,
}));

vi.mock("https", () => ({
  request: mockHttpsRequest,
}));

import { requestJson } from "./http";

type RequestHarness = {
  responseCallback?: (response: EventEmitter & { statusCode?: number }) => void;
  emitRequestError: (error: Error) => void;
  triggerTimeout: () => void;
  destroy: ReturnType<typeof vi.fn>;
};

function wireRequestMock(mockFn: ReturnType<typeof vi.fn>): RequestHarness {
  let timeoutCallback: (() => void) | undefined;
  const listeners: Record<string, ((error: Error) => void) | undefined> = {};

  const destroy = vi.fn((error?: Error) => {
    if (error && listeners.error) {
      listeners.error(error);
    }
  });

  const request = {
    on: vi.fn((event: string, callback: (error: Error) => void) => {
      listeners[event] = callback;
      return request;
    }),
    setTimeout: vi.fn((_timeout: number, callback: () => void) => {
      timeoutCallback = callback;
      return request;
    }),
    destroy,
    end: vi.fn(),
  };

  const harness: RequestHarness = {
    responseCallback: undefined,
    emitRequestError: (error: Error) => listeners.error?.(error),
    triggerTimeout: () => timeoutCallback?.(),
    destroy,
  };

  mockFn.mockImplementation(
    (
      _target: URL,
      _options: { method: string; headers: Record<string, string> },
      callback: (response: EventEmitter & { statusCode?: number }) => void
    ) => {
      harness.responseCallback = callback;
      return request;
    }
  );

  return harness;
}

function createResponse(statusCode: number): EventEmitter & { statusCode?: number } {
  return Object.assign(new EventEmitter(), { statusCode });
}

describe("requestJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid URLs before making a request", async () => {
    await expect(requestJson("not a valid url")).rejects.toThrow();
    expect(mockHttpRequest).not.toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it("uses http.request for http URLs and parses JSON response", async () => {
    const harness = wireRequestMock(mockHttpRequest);
    const promise = requestJson<{ ok: boolean }>("http://localhost:8080/health", { x: "1" });

    const response = createResponse(200);
    harness.responseCallback?.(response);
    response.emit("data", '{"ok":true}');
    response.emit("end");

    await expect(promise).resolves.toEqual({ ok: true });
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it("uses https.request for https URLs", async () => {
    const harness = wireRequestMock(mockHttpsRequest);
    const promise = requestJson<{ status: string }>("https://mcp.example.com/ready");

    const response = createResponse(200);
    harness.responseCallback?.(response);
    response.emit("data", '{"status":"ok"}');
    response.emit("end");

    await expect(promise).resolves.toEqual({ status: "ok" });
    expect(mockHttpRequest).not.toHaveBeenCalled();
  });

  it("rejects when response status is an error with body", async () => {
    const harness = wireRequestMock(mockHttpRequest);
    const promise = requestJson("http://localhost:8080/fail");

    const response = createResponse(500);
    harness.responseCallback?.(response);
    response.emit("data", "bad request");
    response.emit("end");

    await expect(promise).rejects.toThrow("500 bad request");
  });

  it("rejects with generic HTTP message when error body is empty", async () => {
    const harness = wireRequestMock(mockHttpRequest);
    const promise = requestJson("http://localhost:8080/fail-empty");

    const response = createResponse(404);
    harness.responseCallback?.(response);
    response.emit("end");

    await expect(promise).rejects.toThrow("HTTP 404");
  });

  it("resolves to empty object when body is empty and status is success", async () => {
    const harness = wireRequestMock(mockHttpRequest);
    const promise = requestJson<Record<string, never>>("http://localhost:8080/empty");

    const response = createResponse(204);
    harness.responseCallback?.(response);
    response.emit("end");

    await expect(promise).resolves.toEqual({});
  });

  it("rejects when JSON parsing fails", async () => {
    const harness = wireRequestMock(mockHttpRequest);
    const promise = requestJson("http://localhost:8080/invalid-json");

    const response = createResponse(200);
    harness.responseCallback?.(response);
    response.emit("data", "{not-json}");
    response.emit("end");

    await expect(promise).rejects.toThrow("Failed to parse hub response");
  });

  it("rejects when request emits an error", async () => {
    const harness = wireRequestMock(mockHttpRequest);
    const promise = requestJson("http://localhost:8080/error");

    harness.emitRequestError(new Error("network down"));

    await expect(promise).rejects.toThrow("network down");
  });

  it("destroys request and rejects on timeout", async () => {
    const harness = wireRequestMock(mockHttpRequest);
    const promise = requestJson("http://localhost:8080/timeout", {}, 1);

    harness.triggerTimeout();

    await expect(promise).rejects.toThrow("Hub request timed out");
    expect(harness.destroy).toHaveBeenCalled();
  });
});
