// Back up the database now (also runs by itself after every batch and nightly at 02:00 IST).
//   docker compose exec worker npx tsx scripts/backup.ts
import { backupNow } from "@/lib/backup";

backupNow("manual").then((r) => {
  console.log(`${r.message} ${r.file}`);
  process.exit(r.uploaded || !process.env.BACKUP_PAR_URL ? 0 : 1);
});
