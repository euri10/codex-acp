import {RequestError} from "@agentclientprotocol/sdk/unstable";
import {AgentMode, type NativeResumePermissions} from "./AgentMode";
import type {ThreadResumeParams} from "./app-server/v2";

export const RESUME_PERMISSIONS_KEY = "io.github.euri10.louiselm.resumePermissions";
const REASON = "resume_permissions_unavailable";

/** A load-only operator choice, never a startup default or an automatic retry. */
export function readResumePermissionMode(meta?: Record<string, unknown> | null): AgentMode | undefined {
    if (!meta || !Object.hasOwn(meta, RESUME_PERMISSIONS_KEY)) return undefined;
    const value = meta[RESUME_PERMISSIONS_KEY];
    if (value === null || typeof value !== "object" || Array.isArray(value)
        || !("version" in value) || value.version !== 1
        || !("modeId" in value) || typeof value.modeId !== "string") {
        throw RequestError.invalidParams(undefined, "Invalid resume permission choice: expected version 1 and a supported modeId");
    }
    const mode = AgentMode.find(value.modeId);
    if (!mode) throw RequestError.invalidParams(undefined, "Unsupported resume permission modeId");
    return mode;
}

export function resumePermissionsUnavailable(): RequestError {
    return RequestError.invalidRequest({
        reason: REASON,
        [RESUME_PERMISSIONS_KEY]: {
            version: 1,
            modes: AgentMode.all().map(({id, name, description}) => ({id, name, description})),
        },
    }, "Saved permissions cannot be restored safely. Choose a supported replacement mode or cancel; no prompt has been sent.");
}

export function isNativeResumePermissionsUnavailable(error: unknown): boolean {
    if (error === null || typeof error !== "object" || !("code" in error) || error.code !== -32600
        || !("data" in error) || error.data === null || typeof error.data !== "object") return false;
    return "reason" in error.data && error.data.reason === REASON;
}

// Experimental fields are intentionally absent from generated ThreadResumeParams.
export type ResumePermissionOverrides = Pick<ThreadResumeParams, "approvalPolicy" | "approvalsReviewer"> & {
    permissions?: string;
    runtimeWorkspaceRoots?: string[];
};

export function resumePermissionOverrides(mode: AgentMode | undefined, cwd: string, roots: string[]): ResumePermissionOverrides {
    if (!mode) return {};
    return {
        permissions: mode.sandboxMode === "read-only" ? ":read-only"
            : mode.sandboxMode === "danger-full-access" ? ":danger-full-access" : ":workspace",
        approvalPolicy: mode.approvalPolicy,
        approvalsReviewer: mode.approvalsReviewer,
        ...(mode.sandboxMode === "workspace-write" ? {runtimeWorkspaceRoots: [cwd, ...roots]} : {}),
    };
}

export function restoredPermissionMode(
    response: {permissions?: NativeResumePermissions; materialized: boolean},
    roots: string[],
    requested?: AgentMode,
    availableModes: AgentMode[] = AgentMode.all(),
): AgentMode {
    if (!response.materialized) {
        throw RequestError.invalidRequest({reason: "resume_unmaterialized_unavailable"},
            "This Session has no saved prompt history, and this native runtime cannot report its permissions. Start a new Session instead; no prompt has been sent.");
    }
    const restored = AgentMode.fromNativePermissions(response.permissions, roots, availableModes);
    if (!restored || (requested && restored !== requested)) throw resumePermissionsUnavailable();
    return restored;
}

export function resumePermissionAcknowledgement(meta?: Record<string, unknown> | null): {_meta?: Record<string, unknown>} {
    const mode = readResumePermissionMode(meta);
    return mode ? {_meta: {[RESUME_PERMISSIONS_KEY]: {version: 1, modeId: mode.id}}} : {};
}
