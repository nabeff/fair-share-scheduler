import { useState } from "react";
import { JobStatus } from "./JobStatus.tsx";
import { PoolChart } from "./PoolChart.tsx";
import { PoolSummary } from "./PoolSummary.tsx";
import { SubmitForm } from "./SubmitForm.tsx";
import { TenantTable } from "./TenantTable.tsx";
import type { Lookup } from "./useJob.ts";
import { usePool, type Connection } from "./usePool.ts";

const CONNECTION: Record<Connection, string> = {
  connecting: "Connecting",
  live: "Live",
  lost: "No answer from the API, trying again",
};

export function App() {
  const { history, connection } = usePool();
  const pool = history.samples.at(-1)?.pool ?? null;
  // The job in the status panel. Both forms set it: a batch shows its first
  // job, and the panel has a field for any other id.
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const lookUp = (id: string) => setLookup({ id });

  return (
    // Without answers the last picture stays, dimmed: it is old news.
    <main className={connection === "lost" ? "page page-stale" : "page"}>
      <header className="masthead">
        <div>
          <h1>Fair share scheduler</h1>
          <p>Who holds the workers, second by second.</p>
        </div>
        <p className={`connection connection-${connection}`} role="status">
          <i aria-hidden="true" />
          {CONNECTION[connection]}
        </p>
      </header>

      <PoolSummary pool={pool} />

      {/* In this order for a narrow screen. A wide one puts the two tools
          beside the chart, so the chart is in view while jobs are sent. */}
      <div className="board">
        <section className="card chart-card pool-data">
          <PoolChart history={history} />
        </section>
        <div className="tools">
          <SubmitForm
            tenants={pool?.tenants.map((tenant) => tenant.id) ?? []}
            onStored={lookUp}
          />
          <JobStatus lookup={lookup} onLookUp={lookUp} />
        </div>
        <TenantTable history={history} />
      </div>
    </main>
  );
}
