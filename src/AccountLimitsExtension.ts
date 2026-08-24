import type {
    AccountRateLimitsUpdatedNotification,
    GetAccountRateLimitsResponse,
    RateLimitSnapshot,
    RateLimitWindow,
} from "./app-server/v2";

export const ACCOUNT_LIMITS_META_KEY = "io.github.euri10.louiselm";
export const ACCOUNT_LIMITS_READ_METHOD = "_io.github.euri10.louiselm/account_limits/read";
export const ACCOUNT_LIMITS_UPDATED_METHOD = "_io.github.euri10.louiselm/account_limits/updated";

export type AccountLimitWindow = {
    usedPercent: number;
    windowDurationMins: number;
    resetsAt: number;
};

export type AccountLimitBucket = {
    id: string;
    label?: string;
    windows: AccountLimitWindow[];
    reachedType?: string;
    planType?: string;
    credits?: {
        balance?: number;
        unlimited?: boolean;
    };
};

export type AccountLimitResetCredit = {
    id?: string;
    expiresAt?: number;
    title?: string;
    description?: string;
};

export type AccountLimitsSnapshot = {
    defaultBucketId?: string;
    buckets: AccountLimitBucket[];
    unlimited?: boolean;
    resetCredits?: {
        availableCount: number;
        credits?: AccountLimitResetCredit[];
    };
};

function mergeWindow(previous: RateLimitWindow | null, update: RateLimitWindow | null): RateLimitWindow | null {
    if (update === null) {
        return previous;
    }
    return {
        usedPercent: update.usedPercent,
        windowDurationMins: update.windowDurationMins ?? previous?.windowDurationMins ?? null,
        resetsAt: update.resetsAt ?? previous?.resetsAt ?? null,
    };
}

function mergeRateLimit(previous: RateLimitSnapshot | undefined, update: RateLimitSnapshot): RateLimitSnapshot {
    return {
        limitId: update.limitId ?? previous?.limitId ?? null,
        limitName: update.limitName ?? previous?.limitName ?? null,
        primary: mergeWindow(previous?.primary ?? null, update.primary),
        secondary: mergeWindow(previous?.secondary ?? null, update.secondary),
        credits: update.credits ?? previous?.credits ?? null,
        individualLimit: update.individualLimit ?? previous?.individualLimit ?? null,
        spendControlReached: update.spendControlReached ?? previous?.spendControlReached ?? null,
        planType: update.planType ?? previous?.planType ?? null,
        rateLimitReachedType: update.rateLimitReachedType ?? previous?.rateLimitReachedType ?? null,
    };
}

/** Merge one sparse rolling update into the last authoritative App Server read. */
export function mergeAccountLimits(
    previous: GetAccountRateLimitsResponse,
    update: AccountRateLimitsUpdatedNotification["rateLimits"],
): GetAccountRateLimitsResponse {
    const defaultId = previous.rateLimits.limitId ?? previous.rateLimits.limitName ?? "default";
    const updateId = update.limitId ?? defaultId;
    const previousById = previous.rateLimitsByLimitId ?? {};
    const previousBucket = previousById[updateId]
        ?? (defaultId === updateId ? previous.rateLimits : undefined);
    const merged = mergeRateLimit(previousBucket, update);
    const rateLimitsByLimitId = {...previousById};
    rateLimitsByLimitId[updateId] = merged;

    return {
        rateLimits: defaultId === updateId
            ? mergeRateLimit(previous.rateLimits, update)
            : previous.rateLimits,
        rateLimitsByLimitId,
        rateLimitResetCredits: previous.rateLimitResetCredits,
    };
}

function isMeaningful(snapshot: RateLimitSnapshot): boolean {
    return snapshot.limitId !== null
        || snapshot.limitName !== null
        || snapshot.primary !== null
        || snapshot.secondary !== null
        || snapshot.credits !== null
        || snapshot.planType !== null
        || snapshot.rateLimitReachedType !== null;
}

function normalizeWindow(window: RateLimitWindow | null): AccountLimitWindow | null {
    if (window === null || window.windowDurationMins === null || window.resetsAt === null) {
        return null;
    }
    if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) {
        throw new Error("Codex App Server returned an invalid account-limit percentage");
    }
    if (!Number.isSafeInteger(window.windowDurationMins) || window.windowDurationMins <= 0) {
        throw new Error("Codex App Server returned an invalid account-limit duration");
    }
    if (!Number.isSafeInteger(window.resetsAt) || window.resetsAt <= 0) {
        throw new Error("Codex App Server returned an invalid account-limit reset time");
    }
    return {
        usedPercent: window.usedPercent,
        windowDurationMins: window.windowDurationMins,
        resetsAt: window.resetsAt,
    };
}

function normalizeBucket(id: string, snapshot: RateLimitSnapshot): AccountLimitBucket {
    const windows = [normalizeWindow(snapshot.primary), normalizeWindow(snapshot.secondary)]
        .filter((window): window is AccountLimitWindow => window !== null);
    const bucket: AccountLimitBucket = {id, windows};
    if (snapshot.limitName !== null && snapshot.limitName.length > 0) {
        bucket.label = snapshot.limitName;
    }
    if (snapshot.rateLimitReachedType !== null) {
        bucket.reachedType = snapshot.rateLimitReachedType;
    }
    if (snapshot.planType !== null) {
        bucket.planType = snapshot.planType;
    }
    if (snapshot.credits?.unlimited === true) {
        bucket.credits = {unlimited: true};
    } else if (snapshot.credits?.hasCredits === true) {
        const balance = snapshot.credits.balance === null ? undefined : Number(snapshot.credits.balance);
        bucket.credits = {unlimited: false};
        if (balance !== undefined && Number.isFinite(balance) && balance >= 0) {
            bucket.credits.balance = balance;
        }
    }
    return bucket;
}

/** Convert an authoritative App Server response into the provider-neutral ACP payload. */
export function normalizeAccountLimits(response: GetAccountRateLimitsResponse): AccountLimitsSnapshot {
    const buckets = new Map<string, RateLimitSnapshot>();
    for (const [key, snapshot] of Object.entries(response.rateLimitsByLimitId ?? {})) {
        if (snapshot !== undefined && isMeaningful(snapshot)) {
            const id = snapshot.limitId ?? key;
            if (id.length === 0) {
                throw new Error("Codex App Server returned an empty account-limit bucket ID");
            }
            buckets.set(id, snapshot);
        }
    }

    const legacy = response.rateLimits;
    let defaultBucketId: string | undefined;
    if (isMeaningful(legacy)) {
        defaultBucketId = legacy.limitId ?? legacy.limitName ?? "default";
        if (defaultBucketId.length === 0) {
            throw new Error("Codex App Server returned an empty default account-limit bucket ID");
        }
        if (!buckets.has(defaultBucketId)) {
            buckets.set(defaultBucketId, legacy);
        }
    } else if (buckets.size === 1) {
        defaultBucketId = buckets.keys().next().value;
    } else if (buckets.size > 1) {
        throw new Error("Codex App Server omitted the default account-limit bucket identity");
    }

    const orderedIds = [...buckets.keys()].sort((left, right) => {
        if (left === defaultBucketId) return -1;
        if (right === defaultBucketId) return 1;
        return left.localeCompare(right);
    });
    const result: AccountLimitsSnapshot = {
        buckets: orderedIds.map(id => normalizeBucket(id, buckets.get(id)!)),
    };
    if (defaultBucketId !== undefined) {
        result.defaultBucketId = defaultBucketId;
    }
    if (result.buckets.length > 0
        && result.buckets.every(bucket => bucket.windows.length === 0 && bucket.credits?.unlimited === true)) {
        result.unlimited = true;
    }

    const resetCredits = response.rateLimitResetCredits;
    if (resetCredits !== null) {
        const availableCount = Number(resetCredits.availableCount);
        if (!Number.isSafeInteger(availableCount) || availableCount < 0) {
            throw new Error("Codex App Server returned an invalid reset-credit count");
        }
        result.resetCredits = {availableCount};
        if (resetCredits.credits !== null) {
            result.resetCredits.credits = resetCredits.credits.map(credit => {
                const normalized: AccountLimitResetCredit = {};
                if (credit.id.length > 0) normalized.id = credit.id;
                if (credit.expiresAt !== null) {
                    if (!Number.isSafeInteger(credit.expiresAt) || credit.expiresAt <= 0) {
                        throw new Error("Codex App Server returned an invalid reset-credit expiry");
                    }
                    normalized.expiresAt = credit.expiresAt;
                }
                if (credit.title !== null && credit.title.length > 0) normalized.title = credit.title;
                if (credit.description !== null && credit.description.length > 0) {
                    normalized.description = credit.description;
                }
                return normalized;
            });
        }
    }
    return result;
}
