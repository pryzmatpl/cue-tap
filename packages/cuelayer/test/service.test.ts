import { describe, expect, it } from "vitest";
import { startService, type RunningService } from "../src/service.js";
import { buildDocx, highlightRPr, para, run } from "./fixtures.js";

/** Start a service on an ephemeral port with a known token. */
async function start(): Promise<RunningService> {
  return startService({ port: 0, host: "127.0.0.1", token: "test-token" });
}

describe("local parse service", () => {
  it("answers /health with the protocol version", async () => {
    const service = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${service.port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; protocol: number };
      expect(body.ok).toBe(true);
      expect(body.protocol).toBe(1);
    } finally {
      await service.close();
    }
  });

  it("extracts cues from a posted document", async () => {
    const service = await start();
    try {
      const bytes = await buildDocx({
        bodyXml: para(run("Watch this clause.", highlightRPr("yellow"))),
      });

      const res = await fetch(`http://127.0.0.1:${service.port}/extract`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-cuetap-token": "test-token",
          "x-cuetap-filename": "policy.docx",
        },
        body: bytes as BodyInit,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        marked: string;
        cues: { kind: string }[];
        provenance: { cuesFound: number };
      };
      expect(body.ok).toBe(true);
      expect(body.cues).toHaveLength(1);
      expect(body.cues[0]!.kind).toBe("highlight");
      expect(body.marked).toContain("[HIGHLIGHT:YELLOW]");
      expect(body.provenance.cuesFound).toBe(1);
    } finally {
      await service.close();
    }
  });

  it("rejects a request with no token", async () => {
    const service = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${service.port}/extract`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3]) as BodyInit,
      });
      expect(res.status).toBe(401);
    } finally {
      await service.close();
    }
  });

  it("rejects a request with the wrong token", async () => {
    const service = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${service.port}/extract`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "authorization": "Bearer wrong-token",
        },
        body: new Uint8Array([1, 2, 3]) as BodyInit,
      });
      expect(res.status).toBe(401);
    } finally {
      await service.close();
    }
  });

  it("answers a document with no cue layer honestly, not with an error", async () => {
    const service = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${service.port}/extract`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-cuetap-token": "test-token",
        },
        body: new TextEncoder().encode("just plain text") as BodyInit,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; cues: unknown[]; text: string };
      expect(body.ok).toBe(true);
      expect(body.cues).toHaveLength(0);
      expect(body.text).toBe("just plain text");
    } finally {
      await service.close();
    }
  });

  it("refuses an empty body", async () => {
    const service = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${service.port}/extract`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-cuetap-token": "test-token",
        },
        body: new Uint8Array() as BodyInit,
      });
      expect(res.status).toBe(400);
    } finally {
      await service.close();
    }
  });

  it("refuses an oversized body", async () => {
    const service = await startService({ port: 0, host: "127.0.0.1", token: "t", maxBodyBytes: 16 });
    try {
      const res = await fetch(`http://127.0.0.1:${service.port}/extract`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-cuetap-token": "t",
        },
        body: new Uint8Array(1024) as BodyInit,
      });
      expect(res.status).toBe(413);
    } finally {
      await service.close();
    }
  });

  it("returns 404 for an unknown route", async () => {
    const service = await start();
    try {
      const res = await fetch(`http://127.0.0.1:${service.port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await service.close();
    }
  });

  it("binds to loopback only", async () => {
    const service = await startService({ port: 0, host: "127.0.0.1", token: "t" });
    try {
      expect(service.host).toBe("127.0.0.1");
      // The service must not be listening on a routable address.
      const addresses = await localAddresses();
      for (const address of addresses) {
        expect(address).not.toBe("0.0.0.0");
      }
    } finally {
      await service.close();
    }
  });
});

/** The machine's non-loopback IPv4 addresses. */
async function localAddresses(): Promise<string[]> {
  const os = await import("node:os");
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}
