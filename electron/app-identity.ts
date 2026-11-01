import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** Keep settings and Chromium storage in the profile used before the rename. */
const explicitProfile = app.commandLine.getSwitchValue('user-data-dir');
const legacyNames = app.isPackaged ? ['Forge', 'forge'] : ['forge', 'Forge'];
const legacyProfiles = legacyNames.map((name) => path.join(app.getPath('appData'), name));
const profile = explicitProfile
  ? path.resolve(explicitProfile)
  : legacyProfiles.find((candidate) => fs.existsSync(candidate)) ?? legacyProfiles[0];

fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setName('Forge Code');
