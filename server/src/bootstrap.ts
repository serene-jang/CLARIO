import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { emailAddress } from './access.js';

export interface SchoolBootstrap {
  schoolName: string;
  domain: string;
  email: string;
  adminName: string;
}

export function validateSchool(input: SchoolBootstrap): SchoolBootstrap {
  const schoolName = input.schoolName?.trim();
  const adminName = input.adminName?.trim();
  const domain = input.domain?.trim().toLowerCase();
  const email = emailAddress(input.email);
  if (
    !schoolName ||
    schoolName.length > 100 ||
    !adminName ||
    adminName.length > 100 ||
    !domain ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ||
    email.split('@')[1] !== domain
  ) {
    throw new Error('작업공간 이름·관리자 이름과 이메일 도메인을 확인하세요.');
  }
  return { schoolName, domain, email, adminName };
}

export async function bootstrapSchool(pool: Pool, input: SchoolBootstrap, allowExisting = false) {
  const { schoolName, domain, email, adminName } = validateSchool(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('clario-bootstrap'))");
    if (allowExisting) {
      const existing = await client.query(
        `SELECT s.name, u.email, u.name AS admin_name, u.role, u.active
         FROM schools s LEFT JOIN users u ON u.school_id=s.id AND u.email=$2
         WHERE s.google_domain=$1 AND s.name=$3`,
        [domain, email, schoolName],
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (
          row.name !== schoolName ||
          row.email !== email ||
          row.admin_name !== adminName ||
          row.role !== 'school_admin' ||
          row.active !== true
        ) {
          throw new Error(
            '이미 등록된 학교 정보와 다릅니다. 기존 관리자나 학교를 덮어쓰지 않습니다.',
          );
        }
        await client.query('COMMIT');
        return;
      }
    }
    const schoolId = randomUUID();
    const adminId = randomUUID();
    await client.query('INSERT INTO schools(id,name,google_domain) VALUES ($1,$2,$3)', [
      schoolId,
      schoolName,
      domain,
    ]);
    await client.query(
      `INSERT INTO users(id,school_id,email,name,role) VALUES ($1,$2,$3,$4,'school_admin')`,
      [adminId, schoolId, email, adminName],
    );
    await client.query(
      `INSERT INTO audit_logs(school_id,actor_id,action,target_id,result)
       VALUES ($1,$2,'school.bootstrapped',$1,'success')`,
      [schoolId, adminId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
