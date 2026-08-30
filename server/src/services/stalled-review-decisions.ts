import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";

export interface StalledReviewDecisionActor {
  actorType: "agent" | "user";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  actor: StalledReviewDecisionActor;
}

export function stalledReviewDecisionService(db: Db) {
  return {
    decide: async (input: DecideStalledReviewInput) => db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const lockedIssue = await tx
        .select()
        .from(issues)
        .where(and(
          eq(issues.id, input.issueId),
          eq(issues.companyId, input.companyId),
          visibleIssueCondition(),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);

      if (!lockedIssue) throw notFound("Issue not found");
      const actorAgentId = input.actor.actorType === "agent" ? input.actor.agentId ?? null : null;
      const actorUserId = input.actor.actorType === "user" ? input.actor.actorId : null;
      if (input.actor.actorType === "agent") {
        const currentParticipant = parseIssueExecutionState(lockedIssue.executionState)?.currentParticipant;
        if (
          !actorAgentId
          || currentParticipant?.type !== "agent"
          || currentParticipant.agentId !== actorAgentId
        ) {
          throw forbidden("Only the current execution participant can decide this stalled review");
        }
      }
      if (lockedIssue.status !== "in_review") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          currentStatus: lockedIssue.status,
        });
      }

      const svc = issueService(txDb);
      const reviewAttention = await svc
        .listReviewAttention(lockedIssue.companyId, [lockedIssue])
        .then((rows) => rows.get(lockedIssue.id));
      if (reviewAttention?.state !== "stalled") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          reviewAttentionState: reviewAttention?.state ?? "none",
        });
      }

      const comment = input.note
        ? await svc.addComment(
            lockedIssue.id,
            input.note,
            {
              agentId: actorAgentId ?? undefined,
              userId: actorUserId ?? undefined,
              runId: input.actor.runId ?? null,
            },
            { authorType: input.actor.actorType },
            tx,
          )
        : null;
      const requestedStatus = input.action === "approve"
        ? "done"
        : input.actor.actorType === "agent"
          ? "in_progress"
          : "todo";
      const updateFields: Record<string, unknown> = { status: requestedStatus };
      let executionDecision: {
        id: string;
        stageId: string;
        stageType: string;
        outcome: string;
        body: string;
      } | null = null;

      if (input.actor.actorType === "agent") {
        const executionPolicy = normalizeIssueExecutionPolicy(lockedIssue.executionPolicy ?? null);
        const decisionBody = input.note?.trim()
          ?? (input.action === "approve" ? "Approved stalled review." : "Sent stalled review back to work.");
        const transition = applyIssueExecutionPolicyTransition({
          issue: lockedIssue,
          policy: executionPolicy,
          previousPolicy: executionPolicy,
          requestedStatus,
          requestedAssigneePatch: {},
          actor: { agentId: actorAgentId, userId: null },
          commentBody: decisionBody,
        });
        Object.assign(updateFields, transition.patch);
        if (transition.decision) {
          const decisionId = randomUUID();
          const nextExecutionState = updateFields.executionState;
          if (!nextExecutionState || typeof nextExecutionState !== "object") {
            throw new Error("Execution policy decision patch is missing executionState");
          }
          updateFields.executionState = { ...nextExecutionState, lastDecisionId: decisionId };
          executionDecision = { id: decisionId, ...transition.decision };
        }
      }

      const updated = await svc.update(lockedIssue.id, {
        ...updateFields,
        actorAgentId,
        actorUserId,
      }, tx);
      if (!updated) throw notFound("Issue not found");

      if (executionDecision) {
        await tx.insert(issueExecutionDecisions).values({
          id: executionDecision.id,
          companyId: updated.companyId,
          issueId: updated.id,
          stageId: executionDecision.stageId,
          stageType: executionDecision.stageType,
          actorAgentId,
          actorUserId,
          outcome: executionDecision.outcome,
          body: executionDecision.body,
          createdByRunId: input.actor.runId ?? null,
        });
      }

      if (comment) {
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: actorAgentId,
          runId: input.actor.runId ?? null,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            commentId: comment.id,
            authorAgentId: actorAgentId,
            authorUserId: actorUserId,
            source: "stalled_review_decision",
          },
        });
      }
      await logActivity(txDb, {
        companyId: updated.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: actorAgentId,
        runId: input.actor.runId ?? null,
        action: "issue.stalled_review_decided",
        entityType: "issue",
        entityId: updated.id,
        issueId: updated.id,
        details: {
          action: input.action,
          status: updated.status,
          identifier: updated.identifier,
          commentId: comment?.id ?? null,
          authorAgentId: comment ? actorAgentId : null,
          authorUserId: comment ? actorUserId : null,
          executionDecisionId: executionDecision?.id ?? null,
          _previous: { status: lockedIssue.status },
        },
      });

      return { issue: updated, comment };
    }),
  };
}
