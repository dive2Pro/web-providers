import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/helper/app";

describe("helper app", () => {
  it("returns health state for an unbound helper", async () => {
    const app = buildApp({
      token: "test-token",
      browserClient: {
        getConnectionStatus: async () => "disconnected",
      } as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      browser: "disconnected",
      bindState: "unbound",
      degraded: false,
      lastBridgeHeartbeatAt: null,
    });
  });
});
