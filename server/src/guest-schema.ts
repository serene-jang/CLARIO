import type { PoolClient } from 'pg';

export async function migrateGuestParticipation(client: PoolClient) {
  await client.query(`
    ALTER TABLE classes ALTER COLUMN approval_required SET DEFAULT true;
    UPDATE classes SET approval_required=true WHERE NOT approval_required;
    UPDATE classes c SET capacity=GREATEST(capacity,
      (SELECT count(*)::integer FROM class_members m WHERE m.class_id=c.id));
    ALTER TABLE classes ADD CONSTRAINT classroom_teacher_approval_required
      CHECK (approval_required);
    ALTER TABLE classroom_invitations ADD CONSTRAINT classroom_invitation_scope
      UNIQUE(id,class_id);

    CREATE FUNCTION clario_student_name_is_valid(value text) RETURNS boolean
      LANGUAGE sql IMMUTABLE STRICT AS $$
      SELECT char_length(value) BETWEEN 1 AND 100 AND value=normalize(value,NFC)
        AND value=btrim(value,
          U&'\\0009\\000a\\000b\\000c\\000d\\0020\\00a0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200a\\2028\\2029\\202f\\205f\\3000\\feff');
    $$;
    CREATE TABLE classroom_roster_entries (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      name text NOT NULL CHECK (clario_student_name_is_valid(name)),
      student_number text NOT NULL CHECK (student_number ~ '^[0-9]{1,20}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(class_id,student_number),
      UNIQUE(id,class_id)
    );
    CREATE TABLE classroom_participants (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      name text NOT NULL CHECK (clario_student_name_is_valid(name)),
      student_number text NOT NULL CHECK (student_number ~ '^[0-9]{1,20}$'),
      status text NOT NULL DEFAULT 'approved'
        CHECK (status IN ('approved','left','removed','blocked')),
      credential_generation integer NOT NULL DEFAULT 1 CHECK (credential_generation > 0),
      approved_by uuid NOT NULL REFERENCES users(id),
      approved_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(class_id,student_number),
      UNIQUE(id,class_id)
    );
    CREATE TABLE classroom_join_requests (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      invitation_id uuid NOT NULL,
      kind text NOT NULL DEFAULT 'join' CHECK (kind IN ('join','recovery')),
      participant_id uuid,
      name text NOT NULL CHECK (clario_student_name_is_valid(name)),
      student_number text NOT NULL CHECK (student_number ~ '^[0-9]{1,20}$'),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','cancelled')),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      resolved_at timestamptz,
      resolved_by uuid REFERENCES users(id),
      FOREIGN KEY (invitation_id,class_id) REFERENCES classroom_invitations(id,class_id),
      FOREIGN KEY (participant_id,class_id) REFERENCES classroom_participants(id,class_id),
      CHECK (kind<>'recovery' OR participant_id IS NOT NULL),
      CHECK (expires_at > created_at),
      CHECK (
        (status='pending' AND resolved_at IS NULL AND resolved_by IS NULL) OR
        (status IN ('approved','rejected') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL) OR
        (status='cancelled' AND resolved_at IS NOT NULL)
      ),
      CHECK (status<>'approved' OR participant_id IS NOT NULL),
      CHECK (resolved_at IS NULL OR resolved_at >= created_at),
      UNIQUE(id,class_id)
    );
    CREATE INDEX classroom_join_requests_pending ON classroom_join_requests(class_id,created_at)
      WHERE status='pending';
    CREATE TABLE student_participation_sessions (
      token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      class_id uuid NOT NULL REFERENCES classes(id),
      request_id uuid,
      participant_id uuid,
      scope text NOT NULL CHECK (scope IN ('pending','participant')),
      generation integer,
      issued_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      idle_expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      FOREIGN KEY (request_id,class_id) REFERENCES classroom_join_requests(id,class_id),
      FOREIGN KEY (participant_id,class_id) REFERENCES classroom_participants(id,class_id),
      CHECK (
        (scope='pending' AND request_id IS NOT NULL AND participant_id IS NULL AND generation IS NULL) OR
        (scope='participant' AND request_id IS NULL AND participant_id IS NOT NULL AND generation > 0)
      ),
      CHECK (scope<>'participant' OR generation IS NOT NULL),
      CHECK (last_seen_at >= issued_at AND idle_expires_at > last_seen_at
        AND expires_at >= idle_expires_at),
      CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
      CHECK (
        (scope='pending' AND expires_at<=issued_at+interval '30 minutes') OR
        (scope='participant' AND expires_at<=issued_at+interval '12 hours'
          AND idle_expires_at<=last_seen_at+interval '2 hours')
      )
    );
    CREATE UNIQUE INDEX student_participation_session_active
      ON student_participation_sessions(participant_id) WHERE revoked_at IS NULL AND scope='participant';
    CREATE UNIQUE INDEX student_pending_session_active
      ON student_participation_sessions(request_id) WHERE revoked_at IS NULL AND scope='pending';
    CREATE INDEX student_participation_sessions_expiry ON student_participation_sessions(expires_at);
    CREATE FUNCTION protect_student_credential_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ROW(NEW.token_hash,NEW.class_id,NEW.request_id,NEW.participant_id,NEW.scope,NEW.generation,NEW.issued_at)
          IS DISTINCT FROM
          ROW(OLD.token_hash,OLD.class_id,OLD.request_id,OLD.participant_id,OLD.scope,OLD.generation,OLD.issued_at)
          OR NEW.expires_at > OLD.expires_at OR NEW.last_seen_at < OLD.last_seen_at
          OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
        RAISE EXCEPTION 'Student credentials must be rotated, not reassigned or extended'
          USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER student_credential_identity BEFORE UPDATE ON student_participation_sessions
      FOR EACH ROW EXECUTE FUNCTION protect_student_credential_identity();
    CREATE TABLE classroom_participant_attendance (
      session_id uuid NOT NULL,
      class_id uuid NOT NULL,
      participant_id uuid NOT NULL,
      joined_at timestamptz NOT NULL DEFAULT now(),
      left_at timestamptz,
      PRIMARY KEY(session_id,participant_id),
      UNIQUE(session_id,class_id,participant_id),
      FOREIGN KEY (session_id,class_id) REFERENCES classroom_sessions(id,class_id),
      FOREIGN KEY (participant_id,class_id) REFERENCES classroom_participants(id,class_id),
      CHECK (left_at IS NULL OR left_at >= joined_at)
    );
    CREATE TABLE classroom_participant_connections (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL,
      class_id uuid NOT NULL,
      participant_id uuid NOT NULL,
      credential_generation integer NOT NULL CHECK (credential_generation > 0),
      generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      lease_expires_at timestamptz NOT NULL,
      disconnected_at timestamptz,
      FOREIGN KEY (session_id,class_id,participant_id)
        REFERENCES classroom_participant_attendance(session_id,class_id,participant_id),
      CHECK (lease_expires_at >= last_seen_at),
      CHECK (disconnected_at IS NULL OR disconnected_at >= last_seen_at)
    );
    CREATE INDEX classroom_participant_connections_presence
      ON classroom_participant_connections(session_id,participant_id,lease_expires_at);
    CREATE TABLE classroom_participation_audit (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      actor_kind text NOT NULL CHECK (actor_kind IN ('teacher','participant','request')),
      teacher_id uuid REFERENCES users(id),
      participant_id uuid,
      request_id uuid,
      action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
      result text NOT NULL CHECK (result IN ('success','denied','failure')),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (participant_id,class_id) REFERENCES classroom_participants(id,class_id),
      FOREIGN KEY (request_id,class_id) REFERENCES classroom_join_requests(id,class_id),
      CHECK (
        (actor_kind='teacher' AND teacher_id IS NOT NULL AND participant_id IS NULL AND request_id IS NULL) OR
        (actor_kind='participant' AND teacher_id IS NULL AND participant_id IS NOT NULL AND request_id IS NULL) OR
        (actor_kind='request' AND teacher_id IS NULL AND participant_id IS NULL AND request_id IS NOT NULL)
      )
    );
    CREATE INDEX classroom_participation_audit_class
      ON classroom_participation_audit(class_id,created_at);

    CREATE FUNCTION protect_guest_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      target_class uuid;
      maximum integer;
      occupied bigint;
    BEGIN
      IF TG_TABLE_NAME='classes' THEN
        target_class := NEW.id;
        maximum := NEW.capacity;
      ELSE
        target_class := NEW.class_id;
        SELECT capacity INTO maximum FROM classes WHERE id=target_class FOR UPDATE;
      END IF;
      SELECT
        (SELECT count(*) FROM class_members WHERE class_id=target_class) +
        (SELECT count(*) FROM classroom_participants WHERE class_id=target_class AND status='approved')
        INTO occupied;
      IF TG_TABLE_NAME='classroom_participants' THEN
        IF TG_OP='UPDATE' AND OLD.class_id=target_class AND OLD.status='approved' THEN
          occupied := occupied-1;
        END IF;
        IF NEW.status='approved' THEN occupied := occupied+1; END IF;
      ELSIF TG_TABLE_NAME='class_members' THEN
        occupied := occupied+1;
      END IF;
      IF occupied > maximum THEN
        RAISE EXCEPTION 'Classroom capacity exceeded' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER guest_capacity BEFORE INSERT OR UPDATE OF class_id,status
      ON classroom_participants FOR EACH ROW EXECUTE FUNCTION protect_guest_capacity();
    CREATE TRIGGER legacy_guest_capacity BEFORE INSERT ON class_members
      FOR EACH ROW EXECUTE FUNCTION protect_guest_capacity();
    CREATE TRIGGER classroom_capacity BEFORE UPDATE OF capacity ON classes
      FOR EACH ROW EXECUTE FUNCTION protect_guest_capacity();
    INSERT INTO schema_migrations(version) VALUES (7);
  `);
}
