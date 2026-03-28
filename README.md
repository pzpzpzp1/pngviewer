# PNG Viewer for VSCode

View PNG files in VSCode with the default image viewing feel, plus one extra control:

- `Alpha` toggle (default: enabled)
  - Enabled: render PNG with original alpha channel.
  - Disabled: force every pixel alpha to 255 (fully opaque).

The viewer also includes:

- `Save Defaults` button to persist the current alpha setting for future PNG files.
- Cmd/Ctrl + mouse wheel zoom behavior.
- Two-finger/trackpad pan behavior.
- Visual scroll indicators consistent with the EXR viewer interaction model.

## Development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Compile:

   ```bash
   npm run compile
   ```

3. Launch extension host:

   - Open this folder in VSCode and press `F5`.

