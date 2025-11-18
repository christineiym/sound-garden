import fs from 'fs'
import path from 'path'


const dir = path.join('../public/recordings');
const files = fs.readdirSync(dir).filter(f => /\.(mp3|wav|ogg)$/i.test(f));

fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(files, null, 2));
console.log('Updated manifest.json');