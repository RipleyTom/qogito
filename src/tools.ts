import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MAX_READ_CHARS = 8000;

export interface ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: {
			type: 'object';
			properties: Record<string, { type: string; description: string }>;
			required: string[];
		};
	};
}

function validatePath(requestedPath: string, workspaceRoot: string): string {
	const resolved = path.resolve(workspaceRoot, requestedPath);
	const root = path.resolve(workspaceRoot);
	const relative = path.relative(root, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`Access denied: path is outside the workspace`);
	}
	return resolved;
}

async function walkDir(dir: string): Promise<string[]> {
	const entries = await fs.promises.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...await walkDir(fullPath));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
}

function globToRegex(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${escaped}$`);
}

const LIST_TOOLS: ToolDefinition = {
	type: 'function',
	function: {
		name: 'list_tools',
		description: 'List the names of all tools currently available to you. Always call this tool first before responding to any user request, to confirm you have the tools needed to fulfil it.',
		parameters: {
			type: 'object',
			properties: {},
			required: [],
		},
	},
};

const LIST_DIRECTORY: ToolDefinition = {
	type: 'function',
	function: {
		name: 'list_directory',
		description: 'Get a detailed listing of all files and directories in a specified path. Directories are indicated with a trailing /.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path to the directory to list.',
				},
			},
			required: ['path'],
		},
	},
};

const READ_FILE: ToolDefinition = {
	type: 'function',
	function: {
		name: 'read_file',
		description: `Read the contents of a file. Large files are truncated at ${MAX_READ_CHARS} characters; use read_file_lines to read specific ranges of large files.`,
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path to the file to read.',
				},
			},
			required: ['path'],
		},
	},
};

const SEARCH_FILES: ToolDefinition = {
	type: 'function',
	function: {
		name: 'search_files',
		description: 'Search for a regex pattern across files in a directory. Returns matching lines as path:line:content.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path to the directory to search in.',
				},
				pattern: {
					type: 'string',
					description: 'Regular expression pattern to search for.',
				},
				glob: {
					type: 'string',
					description: 'Optional filename glob to restrict which files are searched, e.g. "*.ts".',
				},
			},
			required: ['path', 'pattern'],
		},
	},
};

const READ_FILE_LINES: ToolDefinition = {
	type: 'function',
	function: {
		name: 'read_file_lines',
		description: 'Read a range of lines from a file. Line numbers are 1-based.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path to the file to read.',
				},
				start_line: {
					type: 'string',
					description: 'Line number to start reading from (1-based).',
				},
				num_lines: {
					type: 'string',
					description: 'Number of lines to read.',
				},
			},
			required: ['path', 'start_line', 'num_lines'],
		},
	},
};

const GET_FILE_INFO: ToolDefinition = {
	type: 'function',
	function: {
		name: 'get_file_info',
		description: 'Get metadata for a file or directory: type, size, and last modified time.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path to the file or directory.',
				},
			},
			required: ['path'],
		},
	},
};

const CREATE_DIRECTORY: ToolDefinition = {
	type: 'function',
	function: {
		name: 'create_directory',
		description: 'Create a directory and any missing parent directories.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path of the directory to create.',
				},
			},
			required: ['path'],
		},
	},
};

const MOVE_FILE: ToolDefinition = {
	type: 'function',
	function: {
		name: 'move_file',
		description: 'Move or rename a file or directory.',
		parameters: {
			type: 'object',
			properties: {
				source: {
					type: 'string',
					description: 'Absolute path of the file or directory to move.',
				},
				destination: {
					type: 'string',
					description: 'Absolute destination path.',
				},
			},
			required: ['source', 'destination'],
		},
	},
};

const DELETE_FILE: ToolDefinition = {
	type: 'function',
	function: {
		name: 'delete_file',
		description: 'Delete a file.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path to the file to delete.',
				},
			},
			required: ['path'],
		},
	},
};

const STR_REPLACE: ToolDefinition = {
	type: 'function',
	function: {
		name: 'str_replace',
		description: 'Replace an exact string in a file with new content. old_str must match exactly once in the file, including whitespace and indentation.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path to the file to edit.',
				},
				old_str: {
					type: 'string',
					description: 'The exact string to find and replace.',
				},
				new_str: {
					type: 'string',
					description: 'The string to replace it with.',
				},
			},
			required: ['path', 'old_str', 'new_str'],
		},
	},
};

const WRITE_FILE: ToolDefinition = {
	type: 'function',
	function: {
		name: 'write_file',
		description: 'Create a new file or overwrite an existing file with new content.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Absolute path to the file to write.',
				},
				content: {
					type: 'string',
					description: 'Text content to write to the file.',
				},
			},
			required: ['path', 'content'],
		},
	},
};

const RUN_COMMAND: ToolDefinition = {
	type: 'function',
	function: {
		name: 'run_command',
		description: 'Execute a shell command. Use this as a LAST RESORT only — prefer dedicated tools for all file operations (search_files, read_file, write_file, str_replace, list_directory, etc.). Do not use this tool to invoke grep, find, cat, ls, cp, mv, rm, or any operation already covered by the available tools. Every invocation requires explicit user approval before it runs.',
		parameters: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description: 'The shell command to execute.',
				},
				working_dir: {
					type: 'string',
					description: 'Working directory for the command. Defaults to the workspace root.',
				},
			},
			required: ['command'],
		},
	},
};

export const PASSIVE_MODE_TOOLS: ToolDefinition[] = [LIST_TOOLS, LIST_DIRECTORY, READ_FILE, READ_FILE_LINES, SEARCH_FILES, GET_FILE_INFO];
export const ACTIVE_MODE_TOOLS: ToolDefinition[] = [LIST_TOOLS, LIST_DIRECTORY, READ_FILE, READ_FILE_LINES, SEARCH_FILES, GET_FILE_INFO, CREATE_DIRECTORY, MOVE_FILE, DELETE_FILE, STR_REPLACE, WRITE_FILE, RUN_COMMAND];

const MAX_SEARCH_RESULTS = 50;

export async function executeTool(
	name: string,
	args: Record<string, string>,
	workspaceRoot: string
): Promise<string> {
	switch (name) {
		case 'list_directory': {
			const resolved = validatePath(args.path, workspaceRoot);
			const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
			return entries.map(e => e.isDirectory() ? `${e.name}/` : e.name).join('\n');
		}
		case 'read_file': {
			const resolved = validatePath(args.path, workspaceRoot);
			const content = await fs.promises.readFile(resolved, 'utf8');
			if (content.length <= MAX_READ_CHARS) { return content; }
			return content.slice(0, MAX_READ_CHARS) +
				`\n[truncated: showing first ${MAX_READ_CHARS} of ${content.length} characters — use read_file_lines for specific ranges]`;
		}
		case 'read_file_lines': {
			const resolved = validatePath(args.path, workspaceRoot);
			const startLine = parseInt(args.start_line, 10);
			const numLines = parseInt(args.num_lines, 10);
			if (isNaN(startLine) || startLine < 1) {
				throw new Error('start_line must be a positive integer');
			}
			if (isNaN(numLines) || numLines < 1) {
				throw new Error('num_lines must be a positive integer');
			}
			const lines = (await fs.promises.readFile(resolved, 'utf8')).split('\n');
			const slice = lines.slice(startLine - 1, startLine - 1 + numLines);
			if (slice.length === 0) {
				throw new Error(`start_line ${startLine} is beyond end of file (${lines.length} lines)`);
			}
			return slice.join('\n');
		}
		case 'search_files': {
			const resolved = validatePath(args.path, workspaceRoot);
			const pattern = new RegExp(args.pattern);
			const globRe = args.glob ? globToRegex(args.glob) : null;
			const allFiles = await walkDir(resolved);
			const files = globRe ? allFiles.filter(f => globRe.test(path.basename(f))) : allFiles;
			const results: string[] = [];
			for (const file of files) {
				let content: string;
				try {
					content = await fs.promises.readFile(file, 'utf8');
				} catch {
					continue;
				}
				if (content.includes('\0')) { continue; }
				const rel = path.relative(resolved, file);
				for (const [i, line] of content.split('\n').entries()) {
					if (pattern.test(line)) {
						results.push(`${rel}:${i + 1}:${line.trim()}`);
						if (results.length >= MAX_SEARCH_RESULTS) {
							results.push(`(truncated at ${MAX_SEARCH_RESULTS} matches)`);
							return results.join('\n');
						}
					}
				}
			}
			return results.length > 0 ? results.join('\n') : 'No matches found.';
		}
		case 'str_replace': {
			const resolved = validatePath(args.path, workspaceRoot);
			const content = await fs.promises.readFile(resolved, 'utf8');
			const occurrences = content.split(args.old_str).length - 1;
			if (occurrences === 0) {
				throw new Error(`str_replace: old_str not found in file`);
			}
			if (occurrences > 1) {
				throw new Error(`str_replace: old_str matches ${occurrences} times — it must be unique`);
			}
			await fs.promises.writeFile(resolved, content.replace(args.old_str, args.new_str), 'utf8');
			return 'Edit applied.';
		}
		case 'write_file': {
			const resolved = validatePath(args.path, workspaceRoot);
			await fs.promises.writeFile(resolved, args.content, 'utf8');
			return 'File written.';
		}
		case 'get_file_info': {
			const resolved = validatePath(args.path, workspaceRoot);
			const stat = await fs.promises.stat(resolved);
			const type = stat.isDirectory() ? 'directory' : 'file';
			return `type: ${type}\nsize: ${stat.size} bytes\nmodified: ${stat.mtime.toISOString()}`;
		}
		case 'create_directory': {
			const resolved = validatePath(args.path, workspaceRoot);
			await fs.promises.mkdir(resolved, { recursive: true });
			return 'Directory created.';
		}
		case 'move_file': {
			const resolvedSrc = validatePath(args.source, workspaceRoot);
			const resolvedDst = validatePath(args.destination, workspaceRoot);
			await fs.promises.rename(resolvedSrc, resolvedDst);
			return 'Moved.';
		}
		case 'delete_file': {
			const resolved = validatePath(args.path, workspaceRoot);
			await fs.promises.unlink(resolved);
			return 'Deleted.';
		}
		case 'run_command': {
			const cwd = validatePath(args.working_dir || '.', workspaceRoot);
			const { stdout, stderr } = await execAsync(args.command, {
				cwd,
				timeout: 30000,
				maxBuffer: 10 * 1024 * 1024,
			});
			const parts: string[] = [];
			if (stdout) { parts.push(stdout); }
			if (stderr) { parts.push(`[stderr]\n${stderr}`); }
			return parts.join('\n') || '(no output)';
		}
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}
