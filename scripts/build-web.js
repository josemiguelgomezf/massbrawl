const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const webDirectory = path.join(projectRoot, 'www');
const webFiles = ['index.html', 'firebase-config.js', 'firebase-online.js'];

fs.mkdirSync(webDirectory, { recursive: true });
for (const file of webFiles) {
  fs.copyFileSync(path.join(projectRoot, file), path.join(webDirectory, file));
}

console.log(`Copied ${webFiles.length} web files to ${path.relative(projectRoot, webDirectory)}.`);
