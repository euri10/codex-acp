import {describe, expect, it, onTestFinished, vi} from "vitest";
import {
    ACCOUNT_LIMITS_READ_METHOD,
    ACCOUNT_LIMITS_UPDATED_METHOD,
    mergeAccountLimits,
    normalizeAccountLimits,
    type AccountLimitsSnapshot,
} from "../../AccountLimitsExtension";
import type {GetAccountRateLimitsResponse, RateLimitSnapshot} from "../../app-server/v2";
import {createCodexMockTestFixture} from "../acp-test-utils";
import {createRecoveryFixture, initialize} from "../app-server-recovery/recovery-fixture";
import {connectSession} from "./v2-prompt-harness";

const completeResponse = (): GetAccountRateLimitsResponse => ({
    accountId: null,
    ordinaryUsageAllowed: null,
    rateLimitUpsell: null,
    rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        normalModelSlug: null,
        primary: {usedPercent: 82, windowDurationMins: 300, resetsAt: 4_102_444_800},
        secondary: null,
        credits: {hasCredits: true, unlimited: false, balance: "7.5"},
        individualLimit: null,
        spendControlReached: false,
        planType: "plus",
        rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
        codex: {
            limitId: "codex",
            limitName: "Codex",
            normalModelSlug: null,
            primary: {usedPercent: 82, windowDurationMins: 300, resetsAt: 4_102_444_800},
            secondary: null,
            credits: {hasCredits: true, unlimited: false, balance: "7.5"},
            individualLimit: null,
            spendControlReached: false,
            planType: "plus",
            rateLimitReachedType: null,
        },
        fast: {
            limitId: "fast",
            limitName: null,
            normalModelSlug: null,
            primary: {usedPercent: 25, windowDurationMins: 90, resetsAt: 4_102_448_400},
            secondary: {usedPercent: 33, windowDurationMins: 10_080, resetsAt: 4_102_452_000},
            credits: null,
            individualLimit: null,
            spendControlReached: null,
            planType: null,
            rateLimitReachedType: null,
        },
    },
    rateLimitResetCredits: {
        availableCount: 1n,
        credits: [{
            id: "credit-1",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: 4_102_440_000,
            expiresAt: 4_102_455_600,
            title: "Reset",
            description: null,
        }],
    },
});

describe("account limits extension", () => {
    it("keeps empty and explicit unlimited responses distinct", () => {
        const empty: GetAccountRateLimitsResponse = {
            accountId: null,
            ordinaryUsageAllowed: null,
            rateLimitUpsell: null,
            rateLimits: {
                limitId: null,
                limitName: null,
                normalModelSlug: null,
                primary: null,
                secondary: null,
                credits: null,
                individualLimit: null,
                spendControlReached: null,
                planType: null,
                rateLimitReachedType: null,
            },
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
        };
        expect(normalizeAccountLimits(empty)).toEqual({buckets: []});

        const unlimited = structuredClone(empty);
        unlimited.rateLimits.credits = {hasCredits: false, unlimited: true, balance: null};
        expect(normalizeAccountLimits(unlimited)).toEqual({
            defaultBucketId: "default",
            buckets: [{id: "default", windows: [], credits: {unlimited: true}}],
            unlimited: true,
        });
    });

    it("normalizes and deduplicates the legacy default bucket", () => {
        expect(normalizeAccountLimits(completeResponse())).toEqual({
            defaultBucketId: "codex",
            buckets: [{
                id: "codex",
                label: "Codex",
                windows: [{usedPercent: 82, windowDurationMins: 300, resetsAt: 4_102_444_800}],
                planType: "plus",
                credits: {balance: 7.5, unlimited: false},
            }, {
                id: "fast",
                windows: [
                    {usedPercent: 25, windowDurationMins: 90, resetsAt: 4_102_448_400},
                    {usedPercent: 33, windowDurationMins: 10_080, resetsAt: 4_102_452_000},
                ],
            }],
            resetCredits: {
                availableCount: 1,
                credits: [{id: "credit-1", expiresAt: 4_102_455_600, title: "Reset"}],
            },
        });
    });

    it("merges sparse rolling updates before emitting a complete snapshot", () => {
        const update: RateLimitSnapshot = {
            limitId: "codex",
            limitName: null,
            normalModelSlug: null,
            primary: {usedPercent: 91, windowDurationMins: null, resetsAt: null},
            secondary: null,
            credits: null,
            individualLimit: null,
            spendControlReached: null,
            planType: null,
            rateLimitReachedType: "rate_limit_reached",
        };

        const previous = completeResponse();
        previous.accountId = "account-1";
        previous.rateLimitUpsell = {banner_text: "Upgrade account capacity"};
        const merged = mergeAccountLimits(previous, update);
        expect(merged.accountId).toBe(previous.accountId);
        expect(merged.rateLimitUpsell).toEqual(previous.rateLimitUpsell);
        const normalized = normalizeAccountLimits(merged);
        expect(normalized.buckets[0]).toEqual({
            id: "codex",
            label: "Codex",
            windows: [{usedPercent: 91, windowDurationMins: 300, resetsAt: 4_102_444_800}],
            reachedType: "rate_limit_reached",
            planType: "plus",
            credits: {balance: 7.5, unlimited: false},
        });
        expect(normalized.resetCredits?.availableCount).toBe(1);
    });

    it("applies an identity-free rolling update to the last default bucket", () => {
        const update: RateLimitSnapshot = {
            limitId: null,
            limitName: null,
            normalModelSlug: null,
            primary: {usedPercent: 91, windowDurationMins: null, resetsAt: null},
            secondary: null,
            credits: null,
            individualLimit: null,
            spendControlReached: null,
            planType: null,
            rateLimitReachedType: null,
        };

        const normalized = normalizeAccountLimits(mergeAccountLimits(completeResponse(), update));
        expect(normalized.defaultBucketId).toBe("codex");
        expect(normalized.buckets).toHaveLength(2);
        expect(normalized.buckets[0]?.windows[0]?.usedPercent).toBe(91);
    });

    it.each([1, 2] as const)("clears a reached limit after a weekly reset over ACP v%s", async (version) => {
        // Captured reset sequence for codex/01a1a1ad-741a-7572-aa02-d75a0d3f2e11 (louiselm-y9llm).
        // ~/.local/state/acp-llm-adapter/proxy/connections/ed6b1e72-54ff-4e53-ae88-4b12e5104548.jsonl:339-340
        // The paired native event clears rate_limit_reached_type; other bucket metadata here is synthetic.
        const previous = completeResponse();
        previous.rateLimits.primary = {usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_793_825_883};
        previous.rateLimits.rateLimitReachedType = "rate_limit_reached";
        previous.rateLimitsByLimitId!["codex"] = previous.rateLimits;

        const session = await connectSession(version);
        onTestFinished(() => session.connection.close());
        const limitUpdates = () => session.wireMessages.filter(message =>
            !Array.isArray(message) && "method" in message && message.method === ACCOUNT_LIMITS_UPDATED_METHOD);
        session.setCodexResponse("account/rateLimits/read", async () => previous);
        const initial: AccountLimitsSnapshot = await session.request(ACCOUNT_LIMITS_READ_METHOD, {});
        expect(initial.buckets[0]?.reachedType).toBe("rate_limit_reached");

        const resetWindow = {usedPercent: 2, windowDurationMins: 10_080, resetsAt: 1_794_430_691};
        const update: RateLimitSnapshot = {
            ...previous.rateLimits,
            limitName: null,
            primary: resetWindow,
            credits: null,
            planType: null,
            rateLimitReachedType: null,
        };
        const expected = structuredClone(initial);
        expected.buckets[0]!.windows = [resetWindow];
        delete expected.buckets[0]!.reachedType;

        session.emit({method: "account/rateLimits/updated", params: {rateLimits: update}});
        await vi.waitFor(() => expect(limitUpdates()).toContainEqual({
            jsonrpc: "2.0", method: ACCOUNT_LIMITS_UPDATED_METHOD, params: expected,
        }));

        // Provider classifications can still report a different limit with quota remaining.
        update.rateLimitReachedType = "workspace_member_usage_limit_reached";
        expected.buckets[0]!.reachedType = update.rateLimitReachedType;
        session.emit({method: "account/rateLimits/updated", params: {rateLimits: update}});
        await vi.waitFor(() => expect(limitUpdates()).toContainEqual({
            jsonrpc: "2.0", method: ACCOUNT_LIMITS_UPDATED_METHOD, params: expected,
        }));
    });

    it("serves reads and publishes merged updates over the custom ACP methods", async () => {
        const fixture = createCodexMockTestFixture();
        vi.spyOn(fixture.getCodexAppServerClient(), "accountRateLimitsRead")
            .mockResolvedValue(completeResponse());

        const initial = await fixture.getCodexAcpAgent().extMethod(ACCOUNT_LIMITS_READ_METHOD, {});
        expect(initial).toEqual(normalizeAccountLimits(completeResponse()));
        fixture.clearAcpConnectionDump();

        fixture.sendServerNotification({
            method: "account/rateLimits/updated",
            params: {
                rateLimits: {
                    limitId: "codex",
                    limitName: null,
                    primary: {usedPercent: 101, windowDurationMins: null, resetsAt: null},
                    secondary: null,
                    credits: null,
                    individualLimit: null,
                    spendControlReached: null,
                    planType: null,
                    rateLimitReachedType: null,
                },
            },
        });
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        fixture.sendServerNotification({
            method: "account/rateLimits/updated",
            params: {
                rateLimits: {
                    limitId: "codex",
                    limitName: null,
                    primary: {usedPercent: 95, windowDurationMins: null, resetsAt: null},
                    secondary: null,
                    credits: null,
                    individualLimit: null,
                    spendControlReached: null,
                    planType: null,
                    rateLimitReachedType: null,
                },
            },
        });

        await vi.waitFor(() => {
            expect(fixture.getAcpConnectionEvents([])).toContainEqual({
                method: "notify",
                args: [ACCOUNT_LIMITS_UPDATED_METHOD, expect.objectContaining({
                    defaultBucketId: "codex",
                    buckets: expect.arrayContaining([expect.objectContaining({
                        id: "codex",
                        windows: [{usedPercent: 95, windowDurationMins: 300, resetsAt: 4_102_444_800}],
                    })]),
                })],
            });
        });
    });

    it("publishes account limits after the app-server restarts", async () => {
        const fixture = createRecoveryFixture();
        fixture.answers.set("account/rateLimits/read", () => completeResponse());
        await initialize(fixture);
        await fixture.agent.extMethod(ACCOUNT_LIMITS_READ_METHOD, {});

        await fixture.kill();
        await fixture.agent.listSessions({});
        await fixture.agent.extMethod(ACCOUNT_LIMITS_READ_METHOD, {});
        fixture.acp.notify.mockClear();
        const update = completeResponse().rateLimits;
        update.primary!.usedPercent = 95;
        fixture.current().rpc.notify({method: "account/rateLimits/updated", params: {rateLimits: update}});

        await vi.waitFor(() => {
            const updates = fixture.acp.notify.mock.calls.filter(call =>
                (call as unknown[])[0] === ACCOUNT_LIMITS_UPDATED_METHOD);
            expect(updates).toHaveLength(1);
            expect(updates[0]).toEqual([ACCOUNT_LIMITS_UPDATED_METHOD, expect.objectContaining({
                buckets: expect.arrayContaining([expect.objectContaining({
                    id: "codex",
                    windows: [{usedPercent: 95, windowDurationMins: 300, resetsAt: 4_102_444_800}],
                })]),
            })]);
        });
    });

    it("preserves App Server read failures as ACP request failures", async () => {
        const fixture = createCodexMockTestFixture();
        vi.spyOn(fixture.getCodexAppServerClient(), "accountRateLimitsRead")
            .mockRejectedValue(new Error("account limits unavailable"));

        await expect(fixture.getCodexAcpAgent().extMethod(ACCOUNT_LIMITS_READ_METHOD, {}))
            .rejects.toThrow("account limits unavailable");
    });
});
