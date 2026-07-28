import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, routines } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent remove tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService.remove with a routine assignee", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Regression: routines.assignee_agent_id is the one agent FK on routines with
  // no onDelete clause (created_by/updated_by are already "set null"), and
  // remove() never detached it. Deleting any agent that owned a routine failed
  // with "routines_assignee_agent_id_agents_id_fk" and surfaced as a bare
  // DELETE /api/agents/{id} -> 500.
  //
  // Found by the terraform provider's TestAccRoutineResource_lifecycle, whose
  // post-test destroy could not tear down its own scratch agent.
  it("detaches the routine and deletes the agent instead of failing on the FK", async () => {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Routine Owner Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "general",
      adapterType: "claude_local",
    });

    const [routine] = await db
      .insert(routines)
      .values({ companyId, title: "routine owned by the agent", assigneeAgentId: agentId })
      .returning();

    const removed = await agentService(db).remove(agentId);
    expect(removed?.id).toBe(agentId);

    // agent is gone…
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(0);
    // …and the routine survived, merely orphaned.
    const [after] = await db.select().from(routines).where(eq(routines.id, routine.id));
    expect(after).toBeTruthy();
    expect(after.assigneeAgentId).toBeNull();
  });
});
