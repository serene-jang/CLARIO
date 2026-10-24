import { Pool } from 'pg';
import { migrateClassroomIdentity } from './classroom-schema.js';
import { migrateGuestParticipation } from './guest-schema.js';
import { randomBytes } from 'node:crypto';

export const databaseVersion = 14;

export function connectDatabase(connectionString: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    url.searchParams.delete(key);
  }
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: true },
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', () => console.error('database_connection_error'));
  return pool;
}

export async function migrate(pool: Pool, targetVersion = databaseVersion) {
  if (!Number.isInteger(targetVersion) || targetVersion < 1 || targetVersion > databaseVersion) {
    throw new Error('Unsupported database migration target.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('clario-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = 1');
    if (!applied.rowCount && targetVersion >= 1) {
      await client.query(`
        CREATE TABLE schools (
          id uuid PRIMARY KEY, name text NOT NULL,
          google_domain text NOT NULL UNIQUE CHECK (google_domain = lower(google_domain))
        );
        CREATE TABLE users (
          id uuid PRIMARY KEY, school_id uuid NOT NULL REFERENCES schools(id),
          email text NOT NULL UNIQUE CHECK (email = lower(email)),
          name text NOT NULL, role text NOT NULL
            CHECK (role IN ('teacher', 'student', 'school_admin')),
          google_sub text UNIQUE, active boolean NOT NULL DEFAULT true,
          UNIQUE (id, school_id)
        );
        CREATE TABLE classes (
          id uuid PRIMARY KEY, school_id uuid NOT NULL REFERENCES schools(id),
          teacher_id uuid NOT NULL, name text NOT NULL, archived_at timestamptz,
          FOREIGN KEY (teacher_id, school_id) REFERENCES users(id, school_id),
          UNIQUE (id, school_id)
        );
        CREATE TABLE class_members (
          class_id uuid NOT NULL, student_id uuid NOT NULL, school_id uuid NOT NULL,
          PRIMARY KEY (class_id, student_id),
          FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id),
          FOREIGN KEY (student_id, school_id) REFERENCES users(id, school_id)
        );
        CREATE INDEX class_members_student ON class_members(student_id, class_id);
        CREATE INDEX classes_teacher ON classes(school_id, teacher_id);
        CREATE TABLE auth_challenges (
          id uuid PRIMARY KEY, nonce_hash text NOT NULL,
          expires_at timestamptz NOT NULL
        );
        CREATE TABLE auth_sessions (
          token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
          expires_at timestamptz NOT NULL
        );
        CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
        CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
        CREATE TABLE audit_logs (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          school_id uuid REFERENCES schools(id), actor_id uuid REFERENCES users(id),
          action text NOT NULL, target_id uuid, result text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO schema_migrations(version) VALUES (1);
      `);
    }
    const devicesApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version = 2');
    if (!devicesApplied.rowCount && targetVersion >= 2) {
      await client.query(`
        CREATE TABLE registered_devices (
          id uuid PRIMARY KEY,
          school_id uuid NOT NULL REFERENCES schools(id),
          class_id uuid NOT NULL,
          student_id uuid NOT NULL,
          name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
          asset_number text NOT NULL CHECK (char_length(asset_number) BETWEEN 1 AND 100),
          created_at timestamptz NOT NULL DEFAULT now(),
          FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id),
          FOREIGN KEY (student_id, school_id) REFERENCES users(id, school_id),
          FOREIGN KEY (class_id, student_id) REFERENCES class_members(class_id, student_id)
            ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX registered_devices_school_asset
          ON registered_devices(school_id, lower(asset_number));
        CREATE INDEX registered_devices_class ON registered_devices(class_id);
        INSERT INTO schema_migrations(version) VALUES (2);
      `);
    }
    const connectionApplied = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = 3',
    );
    if (!connectionApplied.rowCount && targetVersion >= 3) {
      await client.query(`
        ALTER TABLE registered_devices ADD COLUMN credential_hash text,
          ADD COLUMN credential_expires_at timestamptz, ADD COLUMN last_seen_at timestamptz;
        CREATE UNIQUE INDEX registered_devices_credential
          ON registered_devices(credential_hash) WHERE credential_hash IS NOT NULL;
        CREATE TABLE device_pairings (
          code_hash text PRIMARY KEY, device_id uuid NOT NULL UNIQUE
            REFERENCES registered_devices(id) ON DELETE CASCADE,
          expires_at timestamptz NOT NULL
        );
        CREATE TABLE class_materials (
          id uuid PRIMARY KEY, class_id uuid NOT NULL REFERENCES classes(id),
          title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
          url text NOT NULL CHECK (char_length(url) <= 2048),
          created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
        );
        CREATE INDEX class_materials_class ON class_materials(class_id, created_at);
        CREATE TABLE material_deliveries (
          material_id uuid NOT NULL REFERENCES class_materials(id) ON DELETE CASCADE,
          device_id uuid NOT NULL REFERENCES registered_devices(id) ON DELETE CASCADE,
          received_at timestamptz, opened_at timestamptz,
          PRIMARY KEY(material_id, device_id)
        );
        INSERT INTO schema_migrations(version) VALUES (3);
      `);
    }
    const focusApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version = 4');
    if (!focusApplied.rowCount && targetVersion >= 4) {
      await client.query(`
        ALTER TABLE classes ADD COLUMN voluntary_focus boolean NOT NULL DEFAULT false;
        INSERT INTO schema_migrations(version) VALUES (4);
      `);
    }
    const workspaceDomainsApplied = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = 5',
    );
    if (!workspaceDomainsApplied.rowCount && targetVersion >= 5) {
      await client.query(`
        ALTER TABLE schools DROP CONSTRAINT IF EXISTS schools_google_domain_key;
        INSERT INTO schema_migrations(version) VALUES (5);
      `);
    }
    const identityApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version = 6');
    if (!identityApplied.rowCount && targetVersion >= 6) {
      await migrateClassroomIdentity(client);
    }
    const guestsApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version = 7');
    if (!guestsApplied.rowCount && targetVersion >= 7) {
      await migrateGuestParticipation(client);
    }
    const joinApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version=8');
    if (!joinApplied.rowCount && targetVersion >= 8) {
      await client.query(`
        CREATE TABLE student_join_rate_secret (
          singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
          secret text NOT NULL CHECK(length(secret)=64)
        );
        CREATE TABLE student_join_rate_events (
          key_hash text NOT NULL CHECK(key_hash ~ '^[0-9a-f]{64}$'),
          attempted_at timestamptz NOT NULL DEFAULT statement_timestamp()
        );
        CREATE INDEX student_join_rate_key ON student_join_rate_events(key_hash,attempted_at);
        CREATE INDEX student_join_rate_expiry ON student_join_rate_events(attempted_at);
        INSERT INTO schema_migrations(version) VALUES(8);
      `);
      await client.query('INSERT INTO student_join_rate_secret(secret) VALUES($1)', [
        randomBytes(32).toString('hex'),
      ]);
    }
    const materialsApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version=9');
    if (!materialsApplied.rowCount && targetVersion >= 9) {
      await client.query(`
        ALTER TABLE class_materials ADD CONSTRAINT class_material_scope UNIQUE(id,class_id);
        CREATE TABLE classroom_material_receipts (
          material_id uuid NOT NULL,
          class_id uuid NOT NULL,
          participant_id uuid NOT NULL,
          received_at timestamptz,
          opened_at timestamptz,
          PRIMARY KEY(material_id,participant_id),
          FOREIGN KEY(material_id,class_id) REFERENCES class_materials(id,class_id) ON DELETE CASCADE,
          FOREIGN KEY(participant_id,class_id) REFERENCES classroom_participants(id,class_id)
        );
        CREATE INDEX classroom_material_receipts_participant
          ON classroom_material_receipts(participant_id,material_id);
        INSERT INTO schema_migrations(version) VALUES(9);
      `);
    }
    const focusVersionApplied = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version=10',
    );
    if (!focusVersionApplied.rowCount && targetVersion >= 10) {
      await client.query(`
        ALTER TABLE classes ADD COLUMN focus_version integer NOT NULL DEFAULT 0 CHECK(focus_version>=0),
          ADD COLUMN focus_updated_at timestamptz NOT NULL DEFAULT statement_timestamp();
        CREATE FUNCTION track_classroom_focus() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.voluntary_focus IS DISTINCT FROM OLD.voluntary_focus THEN
            NEW.focus_version=OLD.focus_version+1;
            NEW.focus_updated_at=statement_timestamp();
          ELSE
            NEW.focus_version=OLD.focus_version;
            NEW.focus_updated_at=OLD.focus_updated_at;
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER classroom_focus_version BEFORE UPDATE ON classes
          FOR EACH ROW EXECUTE FUNCTION track_classroom_focus();
        INSERT INTO schema_migrations(version) VALUES(10);
      `);
    }
    const privacyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version=11');
    if (!privacyApplied.rowCount && targetVersion >= 11) {
      await client.query(`
        CREATE TABLE participant_erasure_requests (
          id uuid PRIMARY KEY,
          class_id uuid NOT NULL REFERENCES classes(id),
          participant_id uuid NOT NULL UNIQUE,
          requested_by uuid NOT NULL REFERENCES users(id),
          requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
          status text NOT NULL DEFAULT 'awaiting_policy' CHECK(status='awaiting_policy'),
          FOREIGN KEY(participant_id,class_id) REFERENCES classroom_participants(id,class_id)
        );
        INSERT INTO schema_migrations(version) VALUES(11);
      `);
    }
    const classroomTools = await client.query('SELECT 1 FROM schema_migrations WHERE version=12');
    if (!classroomTools.rowCount && targetVersion >= 12) {
      await client.query(`
        ALTER TABLE classroom_participation_audit ADD COLUMN target_id uuid;
        CREATE TABLE classroom_documents (
          id uuid PRIMARY KEY, class_id uuid NOT NULL REFERENCES classes(id),
          title text NOT NULL, bytes integer NOT NULL CHECK(bytes>0 AND bytes<=10485760),
          status text NOT NULL CHECK(status IN ('uploading','available','failed','deleting')),
          created_by uuid NOT NULL REFERENCES users(id),
          created_at timestamptz NOT NULL DEFAULT statement_timestamp()
        );
        CREATE INDEX classroom_documents_class ON classroom_documents(class_id,created_at);
        ALTER TABLE classes ADD COLUMN blocked_domains text[] NOT NULL DEFAULT '{}';
        CREATE TABLE classroom_browser_connections(
          id uuid PRIMARY KEY,class_id uuid NOT NULL REFERENCES classes(id),
          participant_id uuid NOT NULL, generation integer NOT NULL,
          student_credential text NOT NULL REFERENCES student_participation_sessions(token_hash),
          code_hash text UNIQUE,code_expires_at timestamptz NOT NULL,
          token_hash text UNIQUE,revoked_at timestamptz,last_seen_at timestamptz,
          FOREIGN KEY(participant_id,class_id) REFERENCES classroom_participants(id,class_id)
        );
        CREATE INDEX classroom_browser_participant ON classroom_browser_connections(participant_id);
        INSERT INTO schema_migrations(version) VALUES(12);
      `);
    }
    const emailAuth = await client.query('SELECT 1 FROM schema_migrations WHERE version=13');
    if (!emailAuth.rowCount && targetVersion >= 13) {
      await client.query(`
        ALTER TABLE users ADD COLUMN password_hash text;
        CREATE TABLE identity_auth_budgets (
          key_hash text PRIMARY KEY,
          attempts integer NOT NULL CHECK(attempts>0),
          expires_at timestamptz NOT NULL
        );
        CREATE INDEX identity_auth_budgets_expiry ON identity_auth_budgets(expires_at);
        INSERT INTO schema_migrations(version) VALUES(13);
      `);
    }
    const targets = await client.query('SELECT 1 FROM schema_migrations WHERE version=14');
    if (!targets.rowCount && targetVersion >= 14) {
      await client.query(`
        ALTER TABLE class_materials ADD COLUMN audience text NOT NULL DEFAULT 'all'
          CHECK(audience IN ('all','selected'));
        ALTER TABLE class_materials ADD CONSTRAINT class_materials_scope UNIQUE(id,class_id);
        CREATE TABLE classroom_material_recipients (
          material_id uuid NOT NULL, class_id uuid NOT NULL, participant_id uuid NOT NULL,
          PRIMARY KEY(material_id,participant_id),
          FOREIGN KEY(material_id,class_id) REFERENCES class_materials(id,class_id) ON DELETE CASCADE,
          FOREIGN KEY(participant_id,class_id) REFERENCES classroom_participants(id,class_id)
        );
        CREATE INDEX classroom_material_recipients_student
          ON classroom_material_recipients(participant_id,material_id);
        INSERT INTO schema_migrations(version) VALUES(14);
      `);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
