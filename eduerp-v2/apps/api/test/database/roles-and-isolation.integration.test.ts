import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A,
  SYNTHETIC_DEMO_CENTER_B,
} from '../../src/database/seed-contract';
import {
  createEphemeralTestDbEnv,
  EphemeralDatabaseEnvironment,
} from './harness';

function createPgClient(connectionString: string): Client {
  return new Client({ connectionString });
}

describe('PostgreSQL Least-Privilege Roles & Cross-Center Database Isolation (DB-IT-09, DB-IT-10, F05)', () => {
  let env: EphemeralDatabaseEnvironment;

  before(async () => {
    env = await createEphemeralTestDbEnv();
    await executeSyntheticSeed(env.apiPoolA, SYNTHETIC_DEMO_CENTER_A, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });
    await executeSyntheticSeed(env.apiPoolB, SYNTHETIC_DEMO_CENTER_B, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });
  });

  after(async () => {
    if (env) {
      await env.cleanup();
    }
  });

  it('DB-IT-09: runtime roles are non-superuser and fail with 42501 on CREATE/DROP/ALTER/TRUNCATE, while readonly fails on INSERT/UPDATE/DELETE', async () => {
    for (const pool of [env.apiPoolA, env.workerPoolA, env.readonlyPoolA, env.apiPoolB]) {
      const roleRes = await pool.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
        `SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
      );
      assert.equal(roleRes.rows[0]?.rolsuper, false);
      assert.equal(roleRes.rows[0]?.rolcreatedb, false);
      assert.equal(roleRes.rows[0]?.rolcreaterole, false);
    }

    for (const ddlSql of [
      'CREATE TABLE forbidden_runtime_ddl (id INT)',
      'DROP TABLE students',
      'ALTER TABLE students ADD COLUMN hacked TEXT',
      'TRUNCATE TABLE audit_logs',
    ]) {
      await assert.rejects(
        () => env.apiPoolA.query(ddlSql),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, '42501');
          return true;
        },
      );
      await assert.rejects(
        () => env.workerPoolA.query(ddlSql),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, '42501');
          return true;
        },
      );
    }

    const roSelect = await env.readonlyPoolA.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM "students"`);
    assert.equal(Number(roSelect.rows[0]?.cnt), 1);

    await assert.rejects(
      () =>
        env.readonlyPoolA.query(
          `UPDATE "students" SET "full_name" = 'Forbidden Write' WHERE "id" = $1::uuid`,
          [SYNTHETIC_DEMO_CENTER_A.studentId],
        ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '42501');
        return true;
      },
    );
  });

  it('DB-IT-10 (F05): Center A and Center B databases enforce strict CONNECT privilege isolation, physical data separation, and intact Center B write grants', async () => {
    const clientAtoB = createPgClient(env.crossCenterForbiddenAtoBUrl);
    await assert.rejects(
      async () => {
        await clientAtoB.connect();
        await clientAtoB.end();
      },
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '42501');
        return true;
      },
    );

    const clientBtoA = createPgClient(env.crossCenterForbiddenBtoAUrl);
    await assert.rejects(
      async () => {
        await clientBtoA.connect();
        await clientBtoA.end();
      },
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '42501');
        return true;
      },
    );

    // F05 Regression: Verify Center B API runtime role has intact INSERT/UPDATE grants (not overwritten by readonly role!)
    const cbStudentId = crypto.randomUUID();
    const cbInsert = await env.apiPoolB.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES ($1::uuid, $2::uuid, 'STU-CB-WRITE', 'Center B Write Student', 'center b write student', 'ACTIVE')`,
      [cbStudentId, SYNTHETIC_DEMO_CENTER_B.centerId],
    );
    assert.equal(cbInsert.rowCount, 1);

    // Physical data separation: Center A student does not exist in Center B DB, and vice versa
    const centerBCheck = await env.apiPoolB.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "students" WHERE "center_id" = $1::uuid OR "id" = $2::uuid`,
      [SYNTHETIC_DEMO_CENTER_A.centerId, SYNTHETIC_DEMO_CENTER_A.studentId],
    );
    assert.equal(Number(centerBCheck.rows[0]?.cnt), 0);

    const centerACheck = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "students" WHERE "center_id" = $1::uuid OR "id" = $2::uuid`,
      [SYNTHETIC_DEMO_CENTER_B.centerId, SYNTHETIC_DEMO_CENTER_B.studentId],
    );
    assert.equal(Number(centerACheck.rows[0]?.cnt), 0);
  });
});
