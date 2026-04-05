import fs from 'fs';
fs.writeFileSync('env_dump.json', JSON.stringify(process.env, null, 2));
console.log('Done');
