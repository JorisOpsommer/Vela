// Operator commands, run inside the container:
//   node dist/server/cli.js reset-password <username>
//   node dist/server/cli.js create-admin <username>
//   node dist/server/cli.js reset-2fa <username>
//   node dist/server/cli.js list-users
// New passwords are generated and printed once; the user must change them at sign-in.
import crypto from 'node:crypto';
import { loadConfig } from './config';
import { openDb } from './db';
import { AuthService } from './auth/service';
import { SecretBox } from './auth/secret-box';

const [cmd, username] = process.argv.slice(2);
const config = loadConfig();
const db = openDb(config.dataDir);
const auth = new AuthService(db, new SecretBox(config.sessionSecret), config.sessionTtlMs);

function find(name: string | undefined) {
    const u = auth.listUsers().find((x) => x.username.toLowerCase() === (name ?? '').toLowerCase());
    if (!u) {
        console.error(`No user "${name}".`);
        process.exit(1);
    }
    return u;
}

const password = () => crypto.randomBytes(15).toString('base64url');

switch (cmd) {
    case 'list-users':
        for (const u of auth.listUsers()) console.log(`${u.username}\t${u.role}${u.disabled ? '\tdisabled' : ''}${u.totpEnabled ? '\t2fa' : ''}`);
        break;
    case 'reset-password': {
        const u = find(username);
        const pw = password();
        await auth.setPassword(u.id, pw, true);
        auth.updateUser(u.id, { disabled: false });
        console.log(`New one-time password for ${u.username}: ${pw}`);
        break;
    }
    case 'create-admin': {
        if (!username) throw new Error('username required');
        const pw = password();
        await auth.createUser(username, pw, 'admin', { mustChangePassword: true });
        console.log(`Created admin ${username} with one-time password: ${pw}`);
        break;
    }
    case 'reset-2fa': {
        const u = find(username);
        auth.resetTotp(u.id);
        console.log(`Two-factor sign-in turned off for ${u.username}.`);
        break;
    }
    default:
        console.log('Usage: cli.js list-users | reset-password <user> | create-admin <user> | reset-2fa <user>');
        process.exitCode = 1;
}
db.close();
