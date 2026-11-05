import {afterAll, beforeEach, describe, expect, it, onTestFinished, vi} from "vitest";
import fs from "node:fs";
import * as codexConnections from "../CodexJsonRpcConnection";
import {createObjectDump, createTestFixture, type TestFixture} from "./acp-test-utils";

describe("real fixture cleanup", {concurrent: false}, () => {
    const observations: {
        child: codexConnections.CodexConnection["process"];
        home: string;
        closed: boolean;
        disposed: boolean;
        closing: Promise<void>;
    }[] = [];
    let fixture: TestFixture;

    function expectCleanedUp() {
        for (const observed of observations) {
            expect(observed.closed, "fixture process and stdio must close before the next test").toBe(true);
            expect(observed.disposed).toBe(true);
            expect(fs.existsSync(observed.home), "temporary CODEX_HOME must be removed").toBe(false);
        }
    }

    beforeEach(() => {
        expectCleanedUp();
        const start = codexConnections.startCodexConnection;
        const spy = vi.spyOn(codexConnections, "startCodexConnection").mockImplementation((...args) => {
            const connection = start(...args);
            const observed = {
                child: connection.process, home: args[1]!["CODEX_HOME"]!, closed: false, disposed: false,
                closing: Promise.resolve(),
            };
            observed.closing = new Promise<void>(resolve => connection.process.once("close", () => {
                observed.closed = true;
                resolve();
            }));
            connection.connection.onDispose(() => { observed.disposed = true; });
            observations.push(observed);
            return connection;
        });
        onTestFinished(() => spy.mockRestore());
        fixture = createTestFixture();
    });

    afterAll(async () => {
        try {
            expectCleanedUp();
            expect(observations).toHaveLength(3);
        } finally {
            // Also reap the real children when this regression fails against the old helper.
            for (const observed of observations) {
                if (!observed.closed) {
                    observed.child.stdin.end();
                    observed.child.kill();
                }
                await observed.closing;
            }
        }
    });

    it("cleans fixtures created in beforeEach and in the same test", async () => {
        await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        await createTestFixture().getCodexAcpAgent().initialize({protocolVersion: 1});
    });

    it.fails("cleans a fixture even when the test throws", async () => {
        await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        throw new Error("intentional failure after real Codex initialization");
    });
});

describe("createObjectDump anonymizer", () => {
    it("anonymizes both direct keys and dotted paths", () => {
        const payload = {
            id: "123",
            meta: {
                token: "secret-token",
                nested: {
                    token: "deep-secret",
                },
            },
            items: [
                {secret: "first-item", visible: "keep"},
                {secret: "second-item"},
            ],
        };

        const dump = createObjectDump(payload, [
            "id",
            "meta.token",
            "meta.nested.token",
            "items.0.secret",
        ]);
        const parsed = JSON.parse(dump);

        expect(parsed.id).toBe("id");
        expect(parsed.meta.token).toBe("token");
        expect(parsed.meta.nested.token).toBe("token");
        expect(parsed.items[0].secret).toBe("secret");
        expect(parsed.items[0].visible).toBe("keep");
        expect(parsed.items[1].secret).toBe("second-item");
    });
});
