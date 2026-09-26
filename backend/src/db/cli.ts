import { adminPool, pool } from './pool.js';
import { migrate, wipe } from './migrate.js';
import { seed } from './seed.js';

const command = process.argv[2];

async function run() {
  switch (command) {
    case 'migrate': {
      const applied = await migrate(adminPool, console.log);
      console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
      break;
    }
    case 'seed': {
      await migrate(adminPool);
      const result = await seed();
      console.log(result);
      break;
    }
    case 'reset': {
      if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database.');
      await wipe(adminPool);
      await migrate(adminPool, console.log);
      console.log(await seed());
      break;
    }
    default:
      console.log('Usage: tsx src/db/cli.ts <migrate|seed|reset>');
      process.exitCode = 1;
  }
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
