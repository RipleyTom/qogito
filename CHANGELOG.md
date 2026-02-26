# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2] - 2026-02-26

### Added

- Added support for displaying thinking
- Added options to hide tool calls/results and thinking entirely

### Fixed

- System message was replacing the compaction, changed the compaction to use a user/assistant pair
- Fixed token estimation after compaction


## [1.2.1] - 2026-02-25

### Added

- Smoother token counting as data is being streamed

### Fixed

- Fixed binary files being possibly included in results of search_files

### Changed

- Changed tool_list to list_tools to better follow the verb_noun nomenclature of most tools
- Cleaned up settings UI for possible future settings


## [1.2.0] - 2026-02-24

### Added

- Added a configurable system prompt under the advanced tab in settings
- Added a tool_list tool to help models reason about which tools are available to them

### Changed

- read_file was changed to truncate the output to avoid models accidentally overwhelming themselves reading big files
- model replies shows up as "qogito:" instead of "assistant:"


## [1.1.1] - 2026-02-23

### Added

- Added PNG icon for the extension package
- Added a changelog
- Added an extra check before sending prompt if context is nearly overloaded for edge cases

### Changed

- Reduced size of the demo example


## [1.1.0] - 2026-02-23

### Added

- Added support for self signed certificates as an option in settings

### Fixed

- Fixed URL in package.json


## [1.0.0] - 2026-02-23

### Added

- First release!
