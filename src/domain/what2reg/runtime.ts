import { createReviewCache, type ReviewCache } from "./cache";
import { fetchForm, fetchTransport } from "./http";
import { createWhat2RegClient, type McpTransport } from "./client";
import { readWhat2RegConfig, type What2RegConfig } from "./config";
import { lookupCourseReviews } from "./lookup";
import { refreshAccessToken, revokeAccess, type FormPoster } from "./oauth";
import {
  PLAN_REVIEW_COURSE_CAP,
  type CommunityReviewNote,
  type ReviewLookup,
  type What2RegGrant,
  type What2RegTokenStore,
} from "./types";

export type What2RegDeps = {
  config: What2RegConfig | null;
  store: What2RegTokenStore;
  cache: ReviewCache;
  transport: McpTransport;
  postForm: FormPoster;
  now: () => number;
};

type GlobalCache = typeof globalThis & { termPilotWhat2RegCache?: ReviewCache };

function sharedCache(): ReviewCache {
  const globalCache = globalThis as GlobalCache;
  globalCache.termPilotWhat2RegCache ??= createReviewCache();
  return globalCache.termPilotWhat2RegCache;
}

export async function resolveTokenStore(): Promise<What2RegTokenStore> {
  if (!process.env.DATABASE_URL) {
    const { memoryWhat2RegTokens } = await import("@/db/what2reg-tokens");
    return memoryWhat2RegTokens();
  }
  const { postgresWhat2RegTokens } = await import("@/db/what2reg-postgres");
  return postgresWhat2RegTokens();
}

export async function resolveRuntimeDeps(): Promise<What2RegDeps> {
  return {
    config: readWhat2RegConfig(),
    store: await resolveTokenStore(),
    cache: sharedCache(),
    transport: fetchTransport(),
    postForm: fetchForm(),
    now: () => Date.now(),
  };
}

async function accessTokenFor(userId: string, deps: What2RegDeps): Promise<string | null> {
  if (!deps.config) return null;
  const grant = await deps.store.get(userId);
  if (!grant) return null;
  const expires = grant.expiresAt ? Date.parse(grant.expiresAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(expires) || expires > deps.now() + 60_000) return grant.accessToken;
  if (!grant.refreshToken) return grant.accessToken;
  const refreshed = await refreshAccessToken({
    config: deps.config,
    refreshToken: grant.refreshToken,
    postForm: deps.postForm,
    now: deps.now(),
  });
  if (!refreshed.ok) {
    await deps.store.delete(userId);
    return null;
  }
  const next: What2RegGrant = {
    ...refreshed.grant,
    refreshToken: refreshed.grant.refreshToken ?? grant.refreshToken,
  };
  await deps.store.save(userId, next);
  return next.accessToken;
}

export async function readReviewsForUser(
  input: { userId: string; courseCode: string; instructors: string[]; reviewInstructorCap?: number },
  deps: What2RegDeps,
): Promise<ReviewLookup> {
  const token = await accessTokenFor(input.userId, deps);
  if (!token || !deps.config) {
    return lookupCourseReviews({
      accessToken: null,
      courseCode: input.courseCode,
      instructors: input.instructors,
      cache: deps.cache,
      callTool: async () => ({ ok: false, code: "unauthorized" }),
    });
  }
  const client = createWhat2RegClient({
    accessToken: token,
    transport: deps.transport,
    endpoint: deps.config.mcpUrl,
  });
  const result = await lookupCourseReviews({
    accessToken: token,
    courseCode: input.courseCode,
    instructors: input.instructors,
    cache: deps.cache,
    reviewInstructorCap: input.reviewInstructorCap,
    callTool: (name, args) => client.callTool(name, args),
  });
  if (result.status === "unauthorized") await deps.store.delete(input.userId);
  return result;
}

export async function notesForCourses(
  userId: string,
  courseCodes: readonly string[],
  deps: What2RegDeps,
): Promise<CommunityReviewNote[]> {
  const notes: CommunityReviewNote[] = [];
  for (const courseCode of courseCodes.slice(0, PLAN_REVIEW_COURSE_CAP)) {
    let result: ReviewLookup;
    try {
      result = await readReviewsForUser({ userId, courseCode, instructors: [], reviewInstructorCap: 1 }, deps);
    } catch {
      continue;
    }
    if (result.status !== "ok") continue;
    const first = result.instructors[0];
    const url = first?.url ?? first?.summaries[0]?.url;
    if (!first || !url) continue;
    notes.push({
      courseCode: result.courseCode,
      instructor: first.name,
      grade: first.grade,
      difficulty: first.difficulty,
      usefulness: first.usefulness,
      summary: first.summaries[0]?.text ?? null,
      url,
    });
  }
  return notes;
}

export async function disconnectUser(userId: string, deps: What2RegDeps): Promise<void> {
  const grant = await deps.store.get(userId);
  if (grant && deps.config) {
    if (grant.refreshToken) {
      await revokeAccess({
        config: deps.config,
        token: grant.refreshToken,
        hint: "refresh_token",
        postForm: deps.postForm,
      });
    }
    await revokeAccess({
      config: deps.config,
      token: grant.accessToken,
      hint: "access_token",
      postForm: deps.postForm,
    });
  }
  await deps.store.delete(userId);
}
