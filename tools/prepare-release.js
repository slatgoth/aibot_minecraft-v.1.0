const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const exePrefix = 'Minecraft LLM Bot';

const findExeFiles = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((name) => name.startsWith(exePrefix) && name.toLowerCase().endsWith('.exe'))
        .map((name) => {
            const fullPath = path.join(dir, name);
            const stats = fs.statSync(fullPath);
            return { name, fullPath, mtimeMs: stats.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
};

const exeFiles = findExeFiles(distDir);
if (exeFiles.length === 0) {
    console.error('No EXE files found in dist/. Build first.');
    process.exit(1);
}

const [latest, ...oldFiles] = exeFiles;
for (const oldFile of oldFiles) {
    fs.unlinkSync(oldFile.fullPath);
}

const targetExe = path.join(root, `${exePrefix}.exe`);
fs.copyFileSync(latest.fullPath, targetExe);

const rootOld = findExeFiles(root).filter((entry) => entry.fullPath !== targetExe);
for (const entry of rootOld) {
    fs.unlinkSync(entry.fullPath);
}

console.log(`Latest EXE: ${latest.name}`);
console.log(`Copied to: ${targetExe}`);
