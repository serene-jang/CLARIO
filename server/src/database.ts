import { Pool } from 'pg';

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

export async function migrate(pool: Pool) {
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
    if (!applied.rowCount) {
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
    if (!devicesApplied.rowCount) {
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
    if (!connectionApplied.rowCount) {
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
    if (!focusApplied.rowCount) {
      await client.query(`
        ALTER TABLE classes ADD COLUMN voluntary_focus boolean NOT NULL DEFAULT false;
        INSERT INTO schema_migrations(version) VALUES (4);
      `);
    }
    const workspaceDomainsApplied = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = 5',
    );
    if (!workspaceDomainsApplied.rowCount) {
      await client.query(`
        ALTER TABLE schools DROP CONSTRAINT IF EXISTS schools_google_domain_key;
        INSERT INTO schema_migrations(version) VALUES (5);
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
