import { count, percent } from "./format.ts";
import { workerTimeShares, type History } from "./history.ts";
import { colorOf } from "./palette.ts";

/**
 * Every tenant, with what it holds now. This is also the chart as numbers,
 * for whoever cannot or does not want to read colors.
 */
export function TenantTable({ history }: { history: History }) {
  const tenants = history.samples.at(-1)?.pool.tenants ?? [];
  const shares = workerTimeShares(history.samples);

  return (
    <section className="card tenants pool-data" aria-labelledby="tenants-title">
      <h2 id="tenants-title">Tenants</h2>
      <p>
        Weight 4 gets four times the workers of weight 1. Share is how much
        worker time each tenant got in the last minute.
      </p>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Tenant</th>
              <th scope="col">Weight</th>
              <th scope="col">Running</th>
              <th scope="col">Waiting</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 && (
              <tr>
                <td className="empty" colSpan={5}>
                  No tenants yet.
                </td>
              </tr>
            )}
            {tenants.map((tenant) => {
              const color = history.colors.get(tenant.id);
              const idle = tenant.running === 0 && tenant.waiting === 0;
              return (
                <tr key={tenant.id} className={idle ? "idle" : ""}>
                  <th scope="row">
                    {color === undefined ? (
                      <i className="key key-none" />
                    ) : (
                      <i
                        className="key"
                        style={{ background: colorOf(color) }}
                      />
                    )}
                    {tenant.id}
                  </th>
                  <td>{count(tenant.weight)}</td>
                  <td>{count(tenant.running)}</td>
                  <td>{count(tenant.waiting)}</td>
                  <td>{percent(shares.get(tenant.id) ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
