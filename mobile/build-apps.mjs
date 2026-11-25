// One command for the phone app builds (DECISIONS 79, 81):
//   cd mobile; node build-apps.mjs
// The same file serves any web game with a mobile/ Capacitor shell (the
// /build-apps skill); only GAME_BUILD below differs between games.
// Rebuilds the game, syncs it into the Android and iOS projects, builds the
// debug APK, the release APK and the release AAB, and zips them with the Xcode
// project into builds/<app>-<version>.zip. Apple's tools can't compile the iOS
// app on Windows; the zip's xcode/ folder opens in Xcode on a Mac.
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
const signed = fs.existsSync(path.join(here, 'android/keystore.properties'));
const tag = signed ? 'release' : 'release-unsigned';
const name = `${slug}-${version}`;

// Everything goes into one folder, then one zip: the three Android files and an
// xcode/ folder that opens on a Mac as it is.
const out = path.join(here, 'builds');
const stage = path.join(out, name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const files = [
  ['android/app/build/outputs/apk/debug/app-debug.apk', `${name}-debug.apk`],
  [`android/app/build/outputs/apk/release/app-${tag}.apk`, `${name}-${tag}.apk`],
  ['android/app/build/outputs/bundle/release/app-release.aab', `${name}-${tag}.aab`],
];
for (const [from, to] of files) fs.copyFileSync(path.join(here, from), path.join(stage, to));

// The Xcode project, with its synced game files. Its Swift package points at
// Capacitor plugins in ../node_modules (CapApp-SPM/Package.swift), so those
// plugins go along at the same relative place, without their Android halves.
const skip = /[\\/](build|DerivedData|xcuserdata|Pods)$/;
fs.cpSync(path.join(here, 'ios'), path.join(stage, 'xcode/ios'), { recursive: true, filter: (p) => !skip.test(p) });
const pkg = fs.readFileSync(path.join(here, 'ios/App/CapApp-SPM/Package.swift'), 'utf8');
for (const [, rel] of pkg.matchAll(/path: "\.\.\/\.\.\/\.\.\/(node_modules\/[^"]+)"/g))
  fs.cpSync(path.join(here, rel), path.join(stage, 'xcode', rel), { recursive: true, filter: (p) => !/[\\/]android$/.test(p) });
const signNote = signed ? 'signed with your upload key' : 'unsigned: sign it before sharing or uploading';
fs.writeFileSync(path.join(stage, 'README.txt'), [
  name,
  '',
  `${files[0][1]}: install on an Android phone for testing (debug key).`,
  `${files[1][1]}: release APK, ${signNote}.`,
  `${files[2][1]}: for Google Play, ${signNote}.`,
  'xcode/ios/App/App.xcodeproj: open in Xcode on a Mac, choose your team under Signing & Capabilities, then build or archive.',
  '',
].join('\n'));

// Windows' own tar (bsdtar) writes zips; Git Bash's GNU tar can't.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32/tar.exe') : 'tar';
const zip = path.join(out, `${name}.zip`);
fs.rmSync(zip, { force: true });
run(`"${tar}" -a -c -f "${zip}" "${name}"`, out);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`\nZIP ${zip} (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);
console.log(`  ${files.map((f) => f[1]).join(', ')}, xcode/`);
if (!signed) console.log('  release files are unsigned: add android/keystore.properties to sign them');
