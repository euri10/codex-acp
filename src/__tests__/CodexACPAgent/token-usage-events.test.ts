import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { TokenUsageBreakdown } from '../../app-server/v2';

function createTokenUsageNotification(
    sessionId: string,
    tokenUsage: {
        total: TokenUsageBreakdown;
        last: TokenUsageBreakdown;
        modelContextWindow: number | null;
    },
    turnId = 'turn-id',
): ServerNotification {
    return {
        method: 'thread/tokenUsage/updated',
        params: {
            threadId: sessionId,
            turnId,
            tokenUsage,
        },
    };
}

describe('Token Usage Events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });
    describe('PromptResponse usage', () => {
        function setupPromptWithTokenUsage(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            // awaitTurnCompleted sends notifications before resolving
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                // Send notifications during turn (after handler is registered)
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return codexAcpAgent;
        }

        it('counts the first observed request without importing an unobserved session baseline', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 5000,
                    inputTokens: 4000,
                    cachedInputTokens: 1000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 900,
                    reasoningOutputTokens: 100,
                },
                last: {
                    totalTokens: 2500,
                    inputTokens: 2000,
                    cachedInputTokens: 500,
                    cacheWriteInputTokens: 0,
                    outputTokens: 450,
                    reasoningOutputTokens: 50,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-end-turn.json'
            );
        });

        it('should include token_count in PromptResponse on cancelled', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 3000,
                    inputTokens: 2500,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 500,
                    reasoningOutputTokens: 0,
                },
                last: {
                    totalTokens: 1500,
                    inputTokens: 1200,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 300,
                    reasoningOutputTokens: 0,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification], "interrupted");

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-cancelled.json'
            );
        });

        it('should return null token_count when no token usage event received', async () => {
            const codexAcpAgent = setupPromptWithTokenUsage([]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-null.json'
            );
        });

        it('should include every request in a turn, including equal-sized requests', async () => {
            const notifications: ServerNotification[] = [
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ];

            const codexAcpAgent = setupPromptWithTokenUsage(notifications);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-multiple-updates.json'
            );
        });

        it('keeps captured multi-request consumption separate from context and subsequent prompts', async () => {
            // Codex 0.153.4, codex/01a0847e-d83a-7052-9eee-945fb6d2e2a5:
            // ~/.codex/sessions/2026/09/09/rollout-2026-09-09T06-48-20-01a0847e-d83a-7052-9eee-945fb6d2e2a5.jsonl
            // token_count frames at lines 20,28,36,42,53,62,69,77,83 precede task_complete (84).
            // These last-request counters and their order are captured; projection to the typed
            // app-server notification is synthetic. The native turn total is 564891 (line 82).
            const capturedRequests = [
                [31696, 7936, 178, 0],
                [41932, 31488, 196, 73],
                [48153, 41728, 182, 0],
                [60311, 48000, 301, 77],
                [61601, 60160, 238, 53],
                [70664, 61440, 262, 43],
                [80134, 70528, 267, 64],
                [83704, 80000, 223, 144],
                [84485, 83584, 364, 137],
            ] as const;
            let total: TokenUsageBreakdown = {
                totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
                outputTokens: 0, reasoningOutputTokens: 0,
            };
            const notifications = capturedRequests.map(([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens]) => {
                const last = {
                    totalTokens: inputTokens + outputTokens, inputTokens, cachedInputTokens,
                    cacheWriteInputTokens: 0, outputTokens, reasoningOutputTokens,
                };
                total = {
                    totalTokens: total.totalTokens + last.totalTokens,
                    inputTokens: total.inputTokens + inputTokens,
                    cachedInputTokens: total.cachedInputTokens + cachedInputTokens,
                    cacheWriteInputTokens: 0,
                    outputTokens: total.outputTokens + outputTokens,
                    reasoningOutputTokens: total.reasoningOutputTokens + reasoningOutputTokens,
                };
                return createTokenUsageNotification(sessionId, {total, last, modelContextWindow: 258400});
            });
            // A repeated delivery is deliberately synthetic: it must not add a second charge.
            notifications.push(notifications[notifications.length - 1]!);
            const agent = setupPromptWithTokenUsage(notifications);
            const prompt = {sessionId, prompt: [{type: 'text' as const, text: 'test prompt'}]};
            const first = await agent.prompt(prompt);
            expect(first.usage).toEqual({
                totalTokens: 564891, inputTokens: 77816, cachedReadTokens: 484864,
                outputTokens: 2211, thoughtTokens: 591,
            });
            expect(first._meta).toMatchObject({
                quota: {token_count: {
                    totalTokens: 564891, inputTokens: 77816, cachedInputTokens: 484864,
                    outputTokens: 2211, reasoningOutputTokens: 591,
                }},
            });
            expect(mockFixture.getAcpConnectionEvents([]).at(-1)).toMatchObject({
                args: [{update: {sessionUpdate: 'usage_update', used: 84849, size: 258400}}],
            });

            // First response of the next observed turn, line 99. Cancellation after it is synthetic.
            notifications.splice(0, notifications.length, createTokenUsageNotification(sessionId, {
                total: {totalTokens: 650006, inputTokens: 647544, cachedInputTokens: 484864,
                    cacheWriteInputTokens: 0, outputTokens: 2462, reasoningOutputTokens: 591},
                last: {totalTokens: 85115, inputTokens: 84864, cachedInputTokens: 0,
                    cacheWriteInputTokens: 0, outputTokens: 251, reasoningOutputTokens: 0},
                modelContextWindow: 258400,
            }, 'next-turn-id'));
            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: {id: 'next-turn-id', items: [], status: 'inProgress', error: null},
            });
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                for (const notification of notifications) mockFixture.sendServerNotification(notification);
                return {threadId: sessionId, turn: {id: 'next-turn-id', items: [], status: 'interrupted', error: null}};
            });
            const cancelled = await agent.prompt(prompt);
            expect(cancelled.stopReason).toBe('cancelled');
            expect(cancelled.usage).toEqual({
                totalTokens: 85115, inputTokens: 84864, cachedReadTokens: 0,
                outputTokens: 251, thoughtTokens: 0,
            });

            const status = await agent.prompt({sessionId, prompt: [{type: 'text', text: '/status'}]});
            expect(status.usage).toBeNull();
            expect(agent.getSessionState(sessionId).lastTokenUsage?.totalTokens).toBe(85115);
            notifications.length = 0;
            expect((await agent.prompt(prompt)).usage).toBeNull();
        });
    });

    describe('session/update usage_update', () => {
        function setupPromptAndReturnEvents(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return async () => {
                await codexAcpAgent.prompt({
                    sessionId,
                    prompt: [{ type: 'text', text: 'test prompt' }],
                });
                return mockFixture.getAcpConnectionEvents([]);
            };
        }

        it('should emit usage_update with latest turn usage as a context proxy', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: {
                        totalTokens: 5000,
                        inputTokens: 4000,
                        cachedInputTokens: 1000,
                        cacheWriteInputTokens: 0,
                        outputTokens: 900,
                        reasoningOutputTokens: 100,
                    },
                    last: {
                        totalTokens: 2500,
                        inputTokens: 2000,
                        cachedInputTokens: 500,
                        cacheWriteInputTokens: 0,
                        outputTokens: 450,
                        reasoningOutputTokens: 50,
                    },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events[0], null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update.json');
        });

        it('should emit latest turn usage from multiple updates', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update-multiple.json');
        });

        it('should skip usage_update when model context window is unavailable', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 100 },
                    last: { totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50 },
                    modelContextWindow: null,
                }),
            ])();

            expect(events).toEqual([]);
        });
    });
});
