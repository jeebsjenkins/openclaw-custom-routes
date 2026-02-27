/**
 * git-ops — Git operations with safety guardrails.
 *
 * Provides branch management, commit, push, and PR creation.
 * Enforces branch naming conventions and protected branch rules.
 *
 * Required secrets in agent's secrets.env:
 *   GIT_TOKEN=ghp_xxxxxxxxxxxx  (GitHub PAT for authenticated push)
 *   GIT_REMOTE=https://github.com/org/repo.git  (optional, overrides origin)
 *
 * Agent config (jvAgent.json) should include:
 *   "git": {
 *     "customerBranch": "customer/acme",
 *     "branchPrefix": "feature/acme-",
 *     "protectedBranches": ["main", "master", "develop"]
 *   }
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const DEFAULT_PROTECTED = ['main', 'master', 'develop', 'release'];

module.exports = {
  name: 'git-ops',
  description: 'Git operations: status, branch, commit, push, diff, log, and PR creation. Enforces branch naming and protected branch safety.',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'branch-create', 'checkout', 'diff', 'add', 'commit', 'push', 'pr-create', 'log', 'branch-list', 'current-branch'],
        description: 'Git operation to perform',
      },
      branch: {
        type: 'string',
        description: 'Branch name (for branch-create, checkout, push)',
      },
      baseBranch: {
        type: 'string',
        description: 'Base branch to create from or target for PR',
      },
      message: {
        type: 'string',
        description: 'Commit message (for commit action)',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files to stage (for add action). Use ["."] for all.',
      },
      prTitle: {
        type: 'string',
        description: 'Pull request title (for pr-create)',
      },
      prBody: {
        type: 'string',
        description: 'Pull request body/description (for pr-create)',
      },
      count: {
        type: 'number',
        description: 'Number of log entries (for log action, default 10)',
        default: 10,
      },
    },
    required: ['action'],
  },

  async execute(input, context) {
    const { action, branch, baseBranch, message, files, prTitle, prBody, count = 10 } = input;
    const { agentSecrets = {}, agentConfig = {}, log } = context;

    // Resolve git config from agent config
    const gitConfig = agentConfig.git || {};
    const protectedBranches = gitConfig.protectedBranches || DEFAULT_PROTECTED;
    const branchPrefix = gitConfig.branchPrefix || '';
    const customerBranch = gitConfig.customerBranch || '';

    // Resolve working directory — use agent's cwd
    const cwd = agentConfig.path || process.cwd();

    // Helper to run git commands
    async function git(...args) {
      try {
        const { stdout, stderr } = await execFileAsync('git', args, {
          cwd,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        return { stdout: stdout.trim(), stderr: stderr.trim() };
      } catch (err) {
        throw new Error(`git ${args[0]} failed: ${err.stderr || err.message}`);
      }
    }

    // Safety check: refuse operations on protected branches
    function assertNotProtected(branchName, operation) {
      if (protectedBranches.includes(branchName)) {
        throw new Error(`SAFETY: Cannot ${operation} on protected branch "${branchName}". Protected branches: ${protectedBranches.join(', ')}`);
      }
    }

    // Safety check: enforce branch prefix if configured
    function assertBranchPrefix(branchName) {
      if (branchPrefix && !branchName.startsWith(branchPrefix)) {
        throw new Error(`SAFETY: Branch "${branchName}" does not match required prefix "${branchPrefix}"`);
      }
    }

    try {
      switch (action) {
        case 'status': {
          const result = await git('status', '--porcelain', '-b');
          return { output: result.stdout || 'Clean working tree' };
        }

        case 'current-branch': {
          const result = await git('branch', '--show-current');
          return { output: result.stdout };
        }

        case 'branch-list': {
          const result = await git('branch', '-a', '--format=%(refname:short) %(objectname:short) %(subject)');
          return { output: result.stdout };
        }

        case 'branch-create': {
          if (!branch) return { output: 'branch name is required', isError: true };
          assertBranchPrefix(branch);

          const base = baseBranch || customerBranch || 'main';
          await git('checkout', '-b', branch, base);
          return { output: `Created and checked out branch "${branch}" from "${base}"` };
        }

        case 'checkout': {
          if (!branch) return { output: 'branch name is required', isError: true };
          await git('checkout', branch);
          return { output: `Checked out branch "${branch}"` };
        }

        case 'diff': {
          const args = ['diff'];
          if (branch) args.push(branch);
          args.push('--stat');
          const result = await git(...args);
          return { output: result.stdout || 'No differences' };
        }

        case 'add': {
          const filesToAdd = files && files.length > 0 ? files : ['.'];
          await git('add', ...filesToAdd);
          return { output: `Staged: ${filesToAdd.join(', ')}` };
        }

        case 'commit': {
          if (!message) return { output: 'commit message is required', isError: true };

          // Check we're not on a protected branch
          const currentBranch = (await git('branch', '--show-current')).stdout;
          assertNotProtected(currentBranch, 'commit');

          await git('commit', '-m', message);
          const headResult = await git('log', '-1', '--oneline');
          return { output: `Committed: ${headResult.stdout}` };
        }

        case 'push': {
          const pushBranch = branch || (await git('branch', '--show-current')).stdout;
          assertNotProtected(pushBranch, 'push');
          if (branchPrefix) assertBranchPrefix(pushBranch);

          // Use authenticated remote if GIT_TOKEN is available
          const gitToken = agentSecrets.GIT_TOKEN || agentSecrets.git_token;
          const gitRemote = agentSecrets.GIT_REMOTE || agentSecrets.git_remote;

          if (gitToken && gitRemote) {
            // Insert token into remote URL for authenticated push
            const authedUrl = gitRemote.replace('https://', `https://x-access-token:${gitToken}@`);
            await git('push', authedUrl, `${pushBranch}:${pushBranch}`, '--set-upstream');
          } else {
            await git('push', '-u', 'origin', pushBranch);
          }

          return { output: `Pushed branch "${pushBranch}"` };
        }

        case 'pr-create': {
          if (!prTitle) return { output: 'prTitle is required for pr-create', isError: true };

          const currentBranch = branch || (await git('branch', '--show-current')).stdout;
          const targetBranch = baseBranch || customerBranch || 'main';

          // Use GitHub CLI (gh) if available
          try {
            const ghArgs = ['pr', 'create',
              '--title', prTitle,
              '--base', targetBranch,
              '--head', currentBranch,
            ];
            if (prBody) ghArgs.push('--body', prBody);

            const { stdout } = await execFileAsync('gh', ghArgs, {
              cwd,
              timeout: 30000,
              env: {
                ...process.env,
                GH_TOKEN: agentSecrets.GIT_TOKEN || agentSecrets.git_token || process.env.GH_TOKEN,
              },
            });

            return { output: `PR created: ${stdout.trim()}` };
          } catch (ghErr) {
            return {
              output: `GitHub CLI (gh) PR creation failed: ${ghErr.message}. Ensure gh is installed and authenticated.`,
              isError: true,
            };
          }
        }

        case 'log': {
          const logCount = Math.min(Math.max(count, 1), 50);
          const result = await git('log', `--oneline`, `-${logCount}`);
          return { output: result.stdout || 'No commits' };
        }

        default:
          return { output: `Unknown action: ${action}`, isError: true };
      }
    } catch (err) {
      if (log) log.error(`[git-ops] ${action} error: ${err.message}`);
      return { output: err.message, isError: true };
    }
  },
};
