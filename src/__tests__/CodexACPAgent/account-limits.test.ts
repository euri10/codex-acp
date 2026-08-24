import {describe, expect, it, vi} from "vitest";
import {
    ACCOUNT_LIMITS_READ_METHOD,
    ACCOUNT_LIMITS_UPDATED_METHOD,
    mergeAccountLimits,
    normalizeAccountLimits,
} from "../../AccountLimitsExtension";
import type {GetAccountRateLimitsResponse, RateLimitSnapshot} from "../../app-server/v2";
import {createCodexMockTestFixture} from "../acp-test-utils";

const completeResponse = (): GetAccountRateLimitsResponse => ({
    rateLimits: {
        limitId: "codex",
        limitName: "Codex",
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
            rateLimits: {
                limitId: null,
                limitName: null,
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
            primary: {usedPercent: 91, windowDurationMins: null, resetsAt: null},
            secondary: null,
            credits: null,
            individualLimit: null,
            spendControlReached: null,
            planType: null,
            rateLimitReachedType: "rate_limit_reached",
        };

        const normalized = normalizeAccountLimits(mergeAccountLimits(completeResponse(), update));
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

    it("preserves App Server read failures as ACP request failures", async () => {
        const fixture = createCodexMockTestFixture();
        vi.spyOn(fixture.getCodexAppServerClient(), "accountRateLimitsRead")
            .mockRejectedValue(new Error("account limits unavailable"));

        await expect(fixture.getCodexAcpAgent().extMethod(ACCOUNT_LIMITS_READ_METHOD, {}))
            .rejects.toThrow("account limits unavailable");
    });
});
