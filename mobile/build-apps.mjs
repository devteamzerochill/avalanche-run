// One command for the phone app builds (DECISIONS 79, 81):
//   cd mobile; node build-apps.mjs
// The same file serves any web game with a mobile/ Capacitor shell (the
// mobile-app-builds skill); only GAME_BUILD below differs between games.
// Rebuilds the game, syncs it into the Android and iOS projects, builds the
// debug APK, the release APK and the release AAB, and copies them to builds/.
// The iOS project (ios/App/App.xcodeproj) is left ready for Xcode on a Mac;
// Apple's tools can't compile it on Windows.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const GAME_BUILD = 'node ../tools/build.mjs'; // rebuilds the web build that capacitor.config.json's webDir points at
const slug = JSON.parse(fs.readFileSync(path.join(here, 'capacitor.config.json'), 'utf8')).appName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const run = (cmd, cwd = here, env = process.env) => execSync(cmd, { cwd, env, stdio: 'inherit' });

// Gradle 8.14 needs Java 21; Android Studio's own Java is newer, so look for a JDK 21 first.
function javaHome() {
  if (process.env.JAVA_HOME && /21/.test(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const roots = ['C:/Program Files/Microsoft', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Java', '/Library/Java/JavaVirtualMachines'];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const jdk = fs.readdirSync(r).find((d) => /jdk-?21/.test(d));
    if (jdk) return fs.existsSync(path.join(r, jdk, 'Contents/Home')) ? path.join(r, jdk, 'Contents/Home') : path.join(r, jdk);
  }
  throw new Error('JDK 21 not found (Windows: winget install Microsoft.OpenJDK.21)');
}
const sdk = process.env.ANDROID_HOME || [path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk'), path.join(process.env.HOME || '', 'Library/Android/sdk')].find((p) => fs.existsSync(p));
if (!sdk) throw new Error('Android SDK not found');
const env = { ...process.env, JAVA_HOME: javaHome(), ANDROID_HOME: sdk };

run(GAME_BUILD);
run('npx cap sync');
// Full path: some Windows setups don't run programs from the current folder by name.
const gradlew = JSON.stringify(path.join(here, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'));
run(`${gradlew} assembleDebug assembleRelease bundleRelease --console=plain`, path.join(here, 'android'), env);

const version = (fs.readFileSync(path.join(here, 'android/app/build.gradle'), 'utf8').match(/versionName "([^"]+)"/) || [])[1] || '0';
const out = path.join(here, 'builds');
fs.mkdirSync(out, { recursive: true });
const signed = fs.existsSync(path.join(here, 'android/keystore.properties'));
const files = [
  ['android/app/build/outputs/apk/debug/app-debug.apk', `${slug}-${version}-debug.apk`],
  [`android/app/build/outputs/apk/release/app-release${signed ? '' : '-unsigned'}.apk`, `${slug}-${version}-release${signed ? '' : '-unsigned'}.apk`],
  ['android/app/build/outputs/bundle/release/app-release.aab', `${slug}-${version}-release${signed ? '' : '-unsigned'}.aab`],
];
for (const [from, to] of files) fs.copyFileSync(path.join(here, from), path.join(out, to));
console.log(`\nbuilds/: ${files.map((f) => f[1]).join(', ')}${signed ? '' : '\n(release files are unsigned: add android/keystore.properties to sign them)'}`);
console.log('iOS: open ios/App/App.xcodeproj in Xcode on a Mac to build and sign.');
