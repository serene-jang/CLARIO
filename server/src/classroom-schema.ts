import type { PoolClient } from 'pg';

export async function migrateClassroomIdentity(client: PoolClient) {
  await client.query(`
    ALTER TABLE users ALTER COLUMN school_id DROP NOT NULL;
    ALTER TABLE users DROP CONSTRAINT users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('teacher','student','school_admin','member'));
    ALTER TABLE users ADD CONSTRAINT users_identity_scope CHECK (
      (role='member' AND school_id IS NULL) OR
      (role IN ('teacher','student','school_admin') AND school_id IS NOT NULL)
    );
    ALTER TABLE classes ALTER COLUMN school_id DROP NOT NULL;
    ALTER TABLE classes ADD CONSTRAINT classes_teacher_identity
      FOREIGN KEY (teacher_id) REFERENCES users(id);
    ALTER TABLE classes ADD COLUMN capacity integer NOT NULL DEFAULT 40
      CHECK (capacity BETWEEN 1 AND 100),
      ADD COLUMN approval_required boolean NOT NULL DEFAULT false,
      ADD COLUMN allowed_domains text[] NOT NULL DEFAULT '{}',
      ADD COLUMN closed_at timestamptz;
    UPDATE classes c SET capacity=GREATEST(40,
      (SELECT count(*)::integer FROM class_members m WHERE m.class_id=c.id));
    CREATE TABLE classroom_memberships (
      class_id uuid NOT NULL REFERENCES classes(id),
      user_id uuid NOT NULL REFERENCES users(id),
      role text NOT NULL CHECK (role IN ('manager','student')),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','left','removed','blocked','cancelled')),
      source text NOT NULL DEFAULT 'direct'
        CHECK (source IN ('direct','legacy_teacher','legacy_student')),
      approved_by uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (class_id,user_id)
    );
    CREATE INDEX classroom_memberships_user ON classroom_memberships(user_id,status);
    INSERT INTO classroom_memberships(class_id,user_id,role,status,source)
      SELECT id,teacher_id,'manager','approved','legacy_teacher' FROM classes;
    INSERT INTO classroom_memberships(class_id,user_id,role,status,source)
      SELECT class_id,student_id,'student','approved','legacy_student' FROM class_members
      ON CONFLICT (class_id,user_id) DO NOTHING;
    CREATE FUNCTION sync_legacy_classroom_teacher() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND OLD.teacher_id IS DISTINCT FROM NEW.teacher_id THEN
        DELETE FROM classroom_memberships
          WHERE class_id=NEW.id AND user_id=OLD.teacher_id AND source='legacy_teacher';
      END IF;
      IF NEW.school_id IS NOT NULL THEN
        INSERT INTO classroom_memberships(class_id,user_id,role,status,source)
          VALUES (NEW.id,NEW.teacher_id,'manager','approved','legacy_teacher')
          ON CONFLICT (class_id,user_id) DO UPDATE
            SET role='manager',status='approved',source='legacy_teacher',updated_at=now();
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER legacy_classroom_teacher AFTER INSERT OR UPDATE OF teacher_id ON classes
      FOR EACH ROW EXECUTE FUNCTION sync_legacy_classroom_teacher();
    CREATE FUNCTION sync_legacy_classroom_student() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        DELETE FROM classroom_memberships WHERE class_id=OLD.class_id
          AND user_id=OLD.student_id AND source='legacy_student';
        RETURN OLD;
      END IF;
      INSERT INTO classroom_memberships(class_id,user_id,role,status,source)
        VALUES (NEW.class_id,NEW.student_id,'student','approved','legacy_student')
        ON CONFLICT (class_id,user_id) DO NOTHING;
      RETURN NEW;
    END $$;
    CREATE TRIGGER legacy_classroom_student AFTER INSERT OR DELETE ON class_members
      FOR EACH ROW EXECUTE FUNCTION sync_legacy_classroom_student();
    CREATE TABLE classroom_invitations (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      code_hash text NOT NULL UNIQUE,
      issued_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      CHECK (expires_at > created_at)
    );
    CREATE UNIQUE INDEX classroom_invitation_active ON classroom_invitations(class_id)
      WHERE revoked_at IS NULL;
    CREATE TABLE classroom_sessions (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      started_by uuid NOT NULL REFERENCES users(id),
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      ended_by uuid REFERENCES users(id),
      UNIQUE(id,class_id),
      CHECK (ended_at IS NULL OR ended_at >= started_at)
    );
    CREATE UNIQUE INDEX classroom_session_active ON classroom_sessions(class_id)
      WHERE ended_at IS NULL;
    CREATE TABLE classroom_session_members (
      session_id uuid NOT NULL,
      class_id uuid NOT NULL,
      user_id uuid NOT NULL,
      joined_at timestamptz NOT NULL DEFAULT now(),
      left_at timestamptz,
      PRIMARY KEY (session_id,user_id),
      UNIQUE (session_id,class_id,user_id),
      FOREIGN KEY (session_id,class_id) REFERENCES classroom_sessions(id,class_id),
      FOREIGN KEY (class_id,user_id) REFERENCES classroom_memberships(class_id,user_id),
      CHECK (left_at IS NULL OR left_at >= joined_at)
    );
    CREATE TABLE classroom_connections (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL,
      class_id uuid NOT NULL,
      user_id uuid NOT NULL,
      generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      lease_expires_at timestamptz NOT NULL,
      disconnected_at timestamptz,
      FOREIGN KEY (session_id,class_id,user_id)
        REFERENCES classroom_session_members(session_id,class_id,user_id),
      CHECK (lease_expires_at >= last_seen_at)
    );
    CREATE INDEX classroom_connections_presence
      ON classroom_connections(session_id,user_id,lease_expires_at);
    INSERT INTO schema_migrations(version) VALUES (6);
  `);
}
