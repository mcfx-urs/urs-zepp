# Changelog

All notable changes to urs-zepp are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- LICENSE (MIT).

### Changed

- Watch-relay shared token is now centralized in `utils/relay-token.js` and masked out of git via a clean/smudge filter, instead of being duplicated as a literal in four page files.

## [0.1.0] - 2026-09-12

### Added

- Two-level menu navigation, replacing the flat single-button layout (#2, #5).
- +330ml beer-log quick action, alongside the existing 500ml one (#2).
- Chores quick-logging from the watch, with menu entries synced from the account's real chore types instead of a hardcoded list (#3, #6).
- Icons on the top-level menu entries (#7).
- Audio notes: record, review, and send a voice note from the watch, with a retryable upload queue and an idle-collapse recording UI (#8).

### Changed

- Updated the app icon.
