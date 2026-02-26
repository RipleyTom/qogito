# Qogito

This is a simple llama.cpp agentic client aiming for simplicity and security.

[![Demo](resources/images/screenshot.png)](resources/animations/qogito_readme.gif)

## Features

* 2 agentic modes:
    * Passive: allow search and reads
    * Active: allow file/directory creation, file removal and file editing and shell commands(which need to be individually validated)
* One shot transformation of selected text in editor in pop up menu
* Auto compacting of conversations when reaching 95% of context
* Separate completion endpoint
* Validates all paths to current workspace

## Requirements

This will not setup llama.cpp for you. You are expected to have it running with the appropriate parameters for your model.

## Release Notes

### 1.2.2

Added support for thinking, options to hide thinking/tool calls and fixed a compaction bug.

## Bugs/Contributions

The source code is available on [Github](https://github.com/RipleyTom/qogito).

Contributions are welcome, keeping in mind the principle of simplicity this extension aims for.
