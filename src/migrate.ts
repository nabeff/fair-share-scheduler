// Creates the tables and loads tenants.json. Runs before the other services.

import { readFile } from "node:fs/promises";
import { config } from "./config.ts";
import { connect, type Db } from "./db.ts";

interface TenantSeed {
  id: string;
  weight: number;
}

// Returns the number of tenants loaded.
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
    // To change a weight: edit tenants.json and restart.
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
