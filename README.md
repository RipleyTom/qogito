# Qogito README

This is a simple llama.cpp agentic client aiming for simplicity and security.

[![Demo](resources/images/screenshot.png)](resources/animations/qogito_readme.webm)

## Features

* 2 agentic modes:
    * Passive: allow search and reads
    * Active: allow file/directory creation, file removal and file editing and shell commands(which need to be individually validated)
* Separate completion endpoint
* One shot transformation of selected text in editor in pop up menu
* Auto compacting of conversations when reaching 95% of context
* Validates all paths to current workspace

## Requirements

This will not setup llama.cpp for you. You are expected to have it running with the appropriate parameters for your model.

## Release Notes

### 1.2.0

Added a new tool tool_list and a system prompt to help models reflect on if they could even execute the user query.
The tool list is needed for non-thinking model to force them to reflect on it.

### 1.1.0

Added support for self signed certificates.

### 1.0.0

Initial release of Qogito.

## Bugs/Contributions

The source code is available on [Github](https://github.com/RipleyTom/qogito).
Contributions are welcome, keeping in mind the principle of simplicity this extension aims for.
