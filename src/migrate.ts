// Creates the tables and seeds the tenants. Runs once before the other services start.

import { readFile } from "node:fs/promises";
import { config } from "./config.ts";
import { connect, type Db } from "./db.ts";

interface TenantSeed {
  id: string;
  weight: number;
}

export async function migrate(
  db: Db,
  tenantsFile = config.tenantsFile,
): Promise<number> {
  const schema = await readFile(
    new URL("../db/schema.sql", import.meta.url),
    "utf8",
  );
  await db.query(schema);

  const tenants: TenantSeed[] = JSON.parse(await readFile(tenantsFile, "utf8"));
  for (const tenant of tenants) {
    // Changing a weight in the file and restarting is how a plan change is applied.
    await db.query(
      `INSERT INTO tenants (id, weight) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET weight = EXCLUDED.weight`,
      [tenant.id, tenant.weight],
    );
  }
  return tenants.length;
}

if (import.meta.main) {
  const db = connect(1);
  const count = await migrate(db);
  console.log(`schema applied, ${count} tenants seeded`);
  await db.end();
}
