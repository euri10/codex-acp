import {afterEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel, mockPromptTurn} from "../acp-test-utils";
import type {Thread, ThreadResumeResponse} from "../../app-server/v2";
import {AgentMode} from "../../AgentMode";

const recoveryKey = "io.github.euri10.louiselm.resumePermissions";
const unavailable = () => Object.assign(new Error("Native policy cannot be resumed"), {
    code: -32600, data: {reason: "resume_permissions_unavailable"},
});

const sessionId = "01a13a4a-e223-7a02-9e1f-7a31ae7c4dda";
const permissions = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: {type: "dangerFullAccess"},
} satisfies Pick<ThreadResumeResponse, "approvalPolicy" | "approvalsReviewer" | "sandbox">;

function fixture(selectedProvider = "openai", savedProvider = "openai") {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    vi.spyOn(client, "readAuthRequirement").mockResolvedValue({required: false, account: null});
    vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(appServer, "configRead").mockResolvedValue({config: {model_provider: selectedProvider}} as never);
    vi.spyOn(appServer, "skillsExtraRootsSet").mockResolvedValue(undefined);
    vi.spyOn(appServer, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(appServer, "listModels").mockResolvedValue({data: [
        createTestModel({id: "configured-model"}),
        createTestModel({id: "saved-model", supportedReasoningEfforts: [
            {reasoningEffort: "medium", description: "Balanced"},
            {reasoningEffort: "high", description: "Thorough"},
        ]}),
    ], nextCursor: null});
    const thread: Thread = {
        id: sessionId, modelProvider: savedProvider, model: "saved-model", reasoningEffort: "high",
        historyMode: "paginated", turns: [],
        sessionId, forkedFromId: null, parentThreadId: null, preview: "", ephemeral: false,
        section: null, sectionEnteredAt: null, projectId: null, createdAt: 1, updatedAt: 1,
        recencyAt: null, status: {type: "idle"}, path: null, cwd: "/workspace", cliVersion: "0",
        originator: null, source: "cli", threadSource: null, agentNickname: null, agentRole: null,
        gitInfo: null, name: null,
    };
    vi.spyOn(appServer, "threadRead").mockResolvedValue({thread});
    vi.spyOn(appServer, "threadUnsubscribe").mockResolvedValue({status: "unsubscribed"});
    // Native thread_processor::merge_persisted_resume_metadata treats any Provider
    // override as replacing the saved Model/effort, even if the Provider is unchanged.
    // Live symptom: louiselm-codex-resume-options-reset-97og3, 2026-10-14 fixture B
    // ACP 01a13a4a-e223-7a02-9e1f-7a31ae7c4dda session proxy log lines20/26.
    const resume = vi.spyOn(appServer, "threadResume").mockImplementation(async params => ({
        thread,
        model: params.modelProvider ? "configured-model" : thread.model,
        reasoningEffort: params.modelProvider ? "medium" : thread.reasoningEffort,
        modelProvider: params.modelProvider ?? savedProvider,
        serviceTier: null,
        itemsBackwardsCursor: null,
        ...permissions,
    } as ThreadResumeResponse));
    const turnStart = mockPromptTurn(fixture, sessionId);
    return {fixture, agent, appServer, resume, turnStart};
}

describe.each(["loadSession", "resumeSession"] as const)("%s restored settings", operation => {
    afterEach(() => vi.unstubAllEnvs());

    it.each(["openai", "azure"])("preserves last-effective Model, effort and Full access on the same %s Provider", async provider => {
        const {agent, resume, turnStart} = fixture(provider, provider);

        const loaded = await agent[operation]({sessionId, cwd: "/workspace", mcpServers: []});

        expect(resume.mock.calls[0]![0].modelProvider).toBeUndefined();
        expect(loaded.configOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({id: "model", currentValue: "saved-model"}),
            expect.objectContaining({id: "reasoning_effort", currentValue: "high"}),
            expect.objectContaining({id: "mode", currentValue: "agent-full-access"}),
        ]));
        expect(turnStart).not.toHaveBeenCalled();

        await agent.prompt({sessionId, prompt: [{type: "text", text: "Continue"}]});

        expect(turnStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            model: "saved-model", effort: "high", approvalPolicy: "never", approvalsReviewer: "user",
            sandboxPolicy: {type: "dangerFullAccess"},
        }));
    });

    it.each([["azure", "openai"], ["openai", "custom-gateway"]])("preserves the explicit Provider switch to %s from %s", async (selected, saved) => {
        const {agent, resume} = fixture(selected, saved);

        const loaded = await agent[operation]({sessionId, cwd: "/workspace", mcpServers: []});

        expect(resume.mock.calls[0]![0].modelProvider).toBe(selected);
        expect(loaded.configOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({id: "model", currentValue: "configured-model"}),
            expect.objectContaining({id: "reasoning_effort", currentValue: "medium"}),
        ]));
    });

    it.each([
        {approvalPolicy: "on-request", activePermissionProfile: {id: ":workspace", extends: null}, sandbox: {
            type: "workspaceWrite", writableRoots: [], networkAccess: false,
            excludeTmpdirEnvVar: true, excludeSlashTmp: true,
        }},
        {approvalPolicy: "untrusted", activePermissionProfile: {id: ":read-only", extends: null},
            sandbox: {type: "readOnly", networkAccess: false}},
        {approvalsReviewer: undefined},
        {approvalPolicy: "on-request", sandbox: {type: "readOnly", networkAccess: false},
            activePermissionProfile: {id: "restricted-read", extends: ":read-only"}},
        {approvalPolicy: "on-request", sandbox: {type: "readOnly", networkAccess: false},
            activePermissionProfile: null},
        {activePermissionProfile: {id: ":read-only", extends: null}},
    ])("refuses to install a session when native permissions cannot be restored: %j", async policy => {
        vi.stubEnv("INITIAL_AGENT_MODE", "agent-full-access");
        const {fixture: observed, agent, resume, turnStart} = fixture();
        const normalResume = resume.getMockImplementation()!;
        resume.mockImplementation(async params => ({
            ...await normalResume(params),
            ...policy,
        } as ThreadResumeResponse));

        await expect(agent[operation]({sessionId, cwd: "/workspace", mcpServers: []}))
            .rejects.toMatchObject({code: -32600, data: {reason: "resume_permissions_unavailable"}});
        expect(() => agent.getSessionState(sessionId)).toThrow("not found");
        expect(turnStart).not.toHaveBeenCalled();
        expect(observed.getAcpConnectionEvents([]).filter(event => event.method === "requestPermission")).toEqual([]);
    });

    it.each([
        {mode: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user",
            sandbox: {type: "readOnly", networkAccess: false}, profile: ":read-only", roots: []},
        {mode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user",
            sandbox: {type: "workspaceWrite", writableRoots: ["/extra-b", "/extra-a", "/extra-a"],
                networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false},
            profile: ":workspace", roots: ["/extra-a", "/extra-b"]},
        {mode: "agent", approvalPolicy: "on-request", approvalsReviewer: "auto_review",
            sandbox: {type: "workspaceWrite", writableRoots: [],
                networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false},
            profile: ":workspace", roots: []},
        {mode: "agent-full-access", ...permissions, profile: ":danger-full-access", roots: []},
    ])("restores supported builtin permission profile for $mode", async policy => {
        const {agent, resume, turnStart} = fixture();
        const normalResume = resume.getMockImplementation()!;
        resume.mockImplementation(async params => ({
            ...await normalResume(params),
            approvalPolicy: policy.approvalPolicy,
            approvalsReviewer: policy.approvalsReviewer,
            sandbox: policy.sandbox,
            activePermissionProfile: {id: policy.profile, extends: null},
        } as ThreadResumeResponse));
        const loaded = await agent[operation]({sessionId, cwd: "/workspace", mcpServers: [], additionalDirectories: policy.roots});
        expect(loaded.configOptions).toContainEqual(expect.objectContaining({id: "mode", currentValue: policy.mode}));
        await agent.prompt({sessionId, prompt: [{type: "text", text: "Continue"}]});
        expect(turnStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer,
            sandboxPolicy: policy.sandbox.type === "workspaceWrite"
                ? {...policy.sandbox, writableRoots: policy.roots} : policy.sandbox,
        }));
    });

    it.each([
        undefined,
        {thread: {id: sessionId}},
        {thread: {id: sessionId, modelProvider: 12}},
        {thread: {id: "another-session", modelProvider: "openai"}},
    ])("rejects malformed native thread metadata without resetting settings: %j", async response => {
        const {agent, appServer, resume} = fixture();
        vi.mocked(appServer.threadRead).mockResolvedValue(response as never);
        await expect(agent[operation]({sessionId, cwd: "/workspace", mcpServers: []}))
            .rejects.toThrow("Invalid thread/read metadata");
        expect(resume).not.toHaveBeenCalled();
    });

    it("refuses missing native permissions even when the client supports notices", async () => {
        const {fixture: observed, agent, resume, turnStart} = fixture();
        const normalResume = resume.getMockImplementation()!;
        resume.mockImplementation(async params => ({
            ...await normalResume(params), sandbox: undefined,
        } as unknown as ThreadResumeResponse));
        await agent.initialize({protocolVersion: 1, clientCapabilities: {session: {notices: {}}}});
        await expect(agent[operation]({sessionId, cwd: "/workspace", mcpServers: []}))
            .rejects.toMatchObject({data: {reason: "resume_permissions_unavailable"}});
        expect(() => agent.getSessionState(sessionId)).toThrow("not found");
        expect(turnStart).not.toHaveBeenCalled();
        expect(observed.getAcpConnectionEvents([]).filter(event => event.method === "requestPermission")).toEqual([]);
    });

    it("reports a metadata read failure before attempting resume", async () => {
        const {agent, appServer, resume} = fixture();
        vi.mocked(appServer.threadRead).mockRejectedValue(new Error("codex app-server transport closed"));
        await expect(agent[operation]({sessionId, cwd: "/workspace", mcpServers: []}))
            .rejects.toThrow("transport closed");
        expect(resume).not.toHaveBeenCalled();
    });

    it("offers four modes on typed native refusal without retrying or installing a Session", async () => {
        const {fixture: observed, agent, resume, turnStart} = fixture();
        resume.mockRejectedValue(unavailable());
        await expect(agent[operation]({sessionId, cwd: "/workspace", mcpServers: []}))
            .rejects.toMatchObject({code: -32600, data: {
                reason: "resume_permissions_unavailable",
                [recoveryKey]: {version: 1, modes: AgentMode.all().map(({id, name, description}) => ({id, name, description}))},
            }});
        expect(resume).toHaveBeenCalledTimes(1);
        expect(turnStart).not.toHaveBeenCalled();
        expect(() => agent.getSessionState(sessionId)).toThrow("not found");
        expect(observed.getAcpConnectionEvents([]).filter(event => event.method === "requestPermission")).toEqual([]);
    });

    it.each(AgentMode.all())("retries only an explicit $name choice, preserving Model/effort and acknowledging it", async builtin => {
        const mode = {...builtin, sandboxPolicy: builtin.sandboxPolicy!};
        const {agent, resume, turnStart} = fixture();
        const normalResume = resume.getMockImplementation()!;
        const profile = mode.id === "read-only" ? ":read-only"
            : mode.id === "agent-full-access" ? ":danger-full-access" : ":workspace";
        resume.mockRejectedValueOnce(unavailable()).mockImplementation(async params => ({
            ...await normalResume(params), approvalPolicy: mode.approvalPolicy, approvalsReviewer: mode.approvalsReviewer,
            sandbox: mode.sandboxPolicy.type === "workspaceWrite" ? {...mode.sandboxPolicy, writableRoots: ["/extra"]} : mode.sandboxPolicy,
            activePermissionProfile: {id: profile, extends: null},
        }));
        const request = {sessionId, cwd: "/workspace", mcpServers: [], additionalDirectories: ["/extra"]};
        await expect(agent[operation](request)).rejects.toMatchObject({data: {reason: "resume_permissions_unavailable"}});
        const loaded = await agent[operation]({...request, _meta: {[recoveryKey]: {version: 1, modeId: mode.id}}});
        expect(resume).toHaveBeenCalledTimes(2);
        expect(resume.mock.calls[1]![0]).toMatchObject({
            threadId: sessionId, permissions: profile, approvalPolicy: mode.approvalPolicy,
            approvalsReviewer: mode.approvalsReviewer,
            ...(mode.sandboxPolicy.type === "workspaceWrite" ? {runtimeWorkspaceRoots: ["/workspace", "/extra"]} : {}),
        });
        expect(resume.mock.calls[1]![0].modelProvider).toBeUndefined();
        expect(resume.mock.calls[1]![0].sandbox).toBeUndefined();
        expect(loaded._meta).toEqual({[recoveryKey]: {version: 1, modeId: mode.id}});
        expect(loaded.configOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({id: "model", currentValue: "saved-model"}),
            expect.objectContaining({id: "reasoning_effort", currentValue: "high"}),
            expect.objectContaining({id: "mode", currentValue: mode.id}),
        ]));
        expect(turnStart).not.toHaveBeenCalled();
        await agent.prompt({sessionId, prompt: [{type: "text", text: "Continue explicitly"}]});
        expect(turnStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            model: "saved-model", effort: "high", approvalPolicy: mode.approvalPolicy,
            approvalsReviewer: mode.approvalsReviewer,
            sandboxPolicy: mode.sandboxPolicy.type === "workspaceWrite"
                ? {...mode.sandboxPolicy, writableRoots: ["/extra"]} : mode.sandboxPolicy,
        }));
    });

    it.each([null, "read-only", [], {}, {version: 2, modeId: "read-only"},
        {version: 1, modeId: 3}, {version: 1, modeId: "custom"}])("rejects malformed explicit choice before native work: %j", async recovery => {
        const {agent, appServer, resume} = fixture();
        await expect(agent[operation]({sessionId, cwd: "/workspace", mcpServers: [], _meta: {[recoveryKey]: recovery}}))
            .rejects.toMatchObject({code: -32602});
        expect(appServer.threadRead).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
    });

    it("does not acknowledge an explicit choice that native ignored", async () => {
        const {agent, resume, turnStart} = fixture();
        await expect(agent[operation]({sessionId, cwd: "/workspace", mcpServers: [],
            _meta: {[recoveryKey]: {version: 1, modeId: "read-only"}}}))
            .rejects.toMatchObject({data: {reason: "resume_permissions_unavailable"}});
        expect(resume).toHaveBeenCalledTimes(1);
        expect(turnStart).not.toHaveBeenCalled();
        expect(() => agent.getSessionState(sessionId)).toThrow("not found");
    });

    it("does not classify an error by matching its human text", async () => {
        const {agent, resume} = fixture();
        const error = new Error("resume_permissions_unavailable");
        resume.mockRejectedValue(error);
        await expect(agent[operation]({sessionId, cwd: "/workspace", mcpServers: []})).rejects.toBe(error);
    });

    it("retains an explicit Provider switch during permission replacement", async () => {
        const {agent, resume} = fixture("azure", "openai");
        const loaded = await agent[operation]({sessionId, cwd: "/workspace", mcpServers: [],
            _meta: {[recoveryKey]: {version: 1, modeId: "agent-full-access"}}});
        expect(resume.mock.calls[0]![0].modelProvider).toBe("azure");
        expect(loaded._meta).toEqual({[recoveryKey]: {version: 1, modeId: "agent-full-access"}});
        expect(loaded.configOptions).toContainEqual(expect.objectContaining({id: "model", currentValue: "configured-model"}));
    });

    it("keeps a native refusal of the selected mode explicit without trying alternatives", async () => {
        const {agent, resume, turnStart} = fixture();
        const refusal = Object.assign(new Error("Current policy does not allow Full access"), {code: -32600});
        resume.mockRejectedValue(refusal);
        await expect(agent[operation]({sessionId, cwd: "/workspace", mcpServers: [],
            _meta: {[recoveryKey]: {version: 1, modeId: "agent-full-access"}}})).rejects.toBe(refusal);
        expect(resume).toHaveBeenCalledTimes(1);
        expect(turnStart).not.toHaveBeenCalled();
        expect(() => agent.getSessionState(sessionId)).toThrow("not found");
    });
});
