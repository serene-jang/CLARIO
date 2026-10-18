import 'dotenv/config';
import { connectDatabase, migrate } from './database.js';
import { bootstrapSchool } from './bootstrap.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = connectDatabase(process.env.DATABASE_URL);
try {
  const [command, schoolName, domainValue, emailValue, adminName] = process.argv.slice(2);
  if (command === 'migrate') {
    await migrate(pool);
    console.log('Database migrations through version 5 applied.');
  } else if (command === 'school') {
    if (!schoolName || !domainValue || !emailValue || !adminName) {
      throw new Error(
        'Usage: school:create -- "School" school.example admin@school.example "Admin"',
      );
    }
    await bootstrapSchool(pool, { schoolName, domain: domainValue, email: emailValue, adminName });
    console.log('School and initial administrator registered.');
  } else {
    throw new Error('Unknown management command.');
  }
} catch (error) {
  console.error(
    'Management command failed:',
    error instanceof Error ? error.message : 'Unknown error.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
