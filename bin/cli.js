#!/usr/bin/env node

import minimist from 'minimist'
import chalk from 'chalk'
import { execSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARCHIVE_DIR = path.join(process.cwd(), '.archives')
const PRIVATE_DIR = path.join(process.cwd(), 'private')

// Helper functions
function execCmd(cmd, showOutput = false) {
  if (showOutput) {
    return execSync(cmd, { encoding: 'utf8', stdio: 'inherit' })
  }
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' })
}

// Spawn a command and handle its output in real-time
function spawnCmd(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'] })
    let output = ''

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n')
      lines.filter(Boolean).forEach(line => {
        if (line.startsWith('gpg:') || line.trim().startsWith('"')) {
          console.log(chalk.gray('> ' + line))
        } else {
          console.log(line)
        }
      })
      output += data
    })

    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n')
      lines.filter(Boolean).forEach(line => {
        if (line.startsWith('gpg:') || line.trim().startsWith('"')) {
          console.log(chalk.gray('> ' + line))
        } else {
          console.error(line)
        }
      })
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output)
      } else {
        reject(new Error(`Command failed with code ${code}`))
      }
    })
  })
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${Math.round(size * 10) / 10} ${units[unit]}`
}

// Parse archive path in format: /<archive>/<path>
function parseArchivePath(archivePath) {
  // Add leading / if missing
  if (!archivePath.startsWith('/')) {
    archivePath = '/' + archivePath
  }

  // Split into parts and remove empty strings
  const parts = archivePath.split('/').filter(Boolean)
  if (parts.length < 1) {
    throw new Error('Invalid archive path')
  }

  // First part is the archive reference
  const archive = parts[0]
  // Rest is the file path
  const filePath = parts.slice(1).join('/') || '*'

  return { archive, filePath }
}

// Find archive by reference (index, hash, or 'latest')
async function findArchive(ref) {
  const archives = await getArchives()
  if (archives.length === 0) {
    throw new Error('No archives found')
  }

  if (ref === 'latest') {
    return archives[0]
  }

  if (/^\d+$/.test(ref)) {
    const index = parseInt(ref)
    const archive = archives[index]
    if (!archive) {
      throw new Error(`Archive index ${ref} not found`)
    }
    return archive
  }

  const archive = archives.find(a => a.git?.hash?.startsWith(ref))
  if (!archive) {
    throw new Error(`Archive with hash ${ref} not found`)
  }
  return archive
}

// Get archives from git history
async function getArchives() {
  try {
    // Get all archives in the directory
    const archives = readdirSync(ARCHIVE_DIR)
      .filter(f => f.endsWith('.tar.gpg'))
      .sort()
      .reverse()
      .map(name => {
        try {
          // Get git info for each archive, but suppress debug output
          const output = execSync(`git log -n 1 --format="%H|%an <%ae>|%s" -- .archives/${name} 2>/dev/null`, { encoding: 'utf8' })
          const [hash, author, message] = output.split('|')
          const size = statSync(path.join(ARCHIVE_DIR, name)).size

          return {
            name,
            size,
            git: {
              hash: hash.slice(0, 7),
              author,
              message
            }
          }
        } catch (e) {
          // Return basic info if not in git
          return {
            name,
            size: statSync(path.join(ARCHIVE_DIR, name)).size,
            git: null
          }
        }
      })

    return archives
  } catch (e) {
    console.error('Error:', e.message)
    return []
  }
}

// Command definitions
const COMMANDS = {
  ls: {
    desc: 'List archives',
    usage: 'ls [options] [archive-ref]',
    options: [
      ['--json', 'Output in JSON format'],
      ['--limit N', 'Limit output to N entries (0 for unlimited)']
    ],
    examples: [
      ['ls', 'List recent archives'],
      ['ls --limit 5', 'Show 5 most recent archives'],
      ['ls /latest', 'Show details of latest archive'],
      ['ls /2', 'Show details of archive at index 2']
    ]
  },
  cat: {
    desc: 'Display contents of files from an archive',
    usage: 'cat <archive-path>',
    options: [
      ['--help', 'Show this help message']
    ],
    examples: [
      ['cat /latest/test.txt', 'Show contents of test.txt from latest archive'],
      ['cat /2/*.md', 'Show all markdown files from archive at index 2']
    ]
  },
  cp: {
    desc: 'Copy files from an archive to a destination',
    usage: 'cp <archive-path> <destination>',
    options: [
      ['--help', 'Show this help message']
    ],
    examples: [
      ['cp /latest/test.txt ./local/', 'Copy test.txt from latest archive to local directory'],
      ['cp /2/*.md ./docs/', 'Copy all markdown files from archive at index 2 to docs directory']
    ]
  },
  less: {
    desc: 'View files from an archive using less',
    usage: 'less <archive-path>',
    options: [
      ['--help', 'Show this help message']
    ],
    examples: [
      ['less /latest/test.txt', 'View test.txt from latest archive'],
      ['less /2/*.md', 'View all markdown files from archive at index 2']
    ]
  },
  verify: {
    desc: 'Verify archive integrity',
    usage: 'verify [archive-ref]',
    options: [
      ['--json', 'Output in JSON format']
    ],
    examples: [
      ['verify', 'Verify latest archive'],
      ['verify /2', 'Verify archive at index 2']
    ]
  },
  restore: {
    desc: 'Restore files from an archive to private directory',
    usage: 'restore [archive-ref]',
    options: [
      ['--json', 'Output in JSON format']
    ],
    examples: [
      ['restore', 'Restore from latest archive'],
      ['restore /2', 'Restore from archive at index 2']
    ]
  },
  pack: {
    desc: 'Create a new encrypted archive from private directory',
    usage: 'pack [options]',
    options: [
      ['--force', 'Create archive even if no changes detected']
    ],
    examples: [
      ['pack', 'Create archive if changes detected'],
      ['pack --force', 'Create archive regardless of changes']
    ]
  },
  clean: {
    desc: 'Remove old uncommitted archives',
    usage: 'clean',
    options: [],
    examples: [
      ['clean', 'Remove all but most recent uncommitted archive']
    ]
  }
}

// Command implementations
const commands = {
  async ls(args) {
    const archives = await getArchives()
    if (archives.length === 0) {
      console.log('No archives found')
      return
    }

    // If archive reference provided, show detailed info
    if (args._.length > 1) {
      const { archive: ref } = parseArchivePath(args._[1])
      args._[1] = ref // Update args for info command
      return commands.info(args)
    }

    const limit = args.limit || 10
    if (limit !== 0) {
      archives.length = Math.min(archives.length, limit)
    }

    if (args.json) {
      console.log(JSON.stringify(archives, null, 2))
      return
    }

    // Process archives
    archives.forEach((archive, index) => {
      const size = formatSize(archive.size)
      const message = archive.git?.message || 'no commit info'
      const author = archive.git?.author || 'unknown'
      const indexStr = `[${index}] `
      const hash = archive.git?.hash ? 
        `${chalk.blue(archive.git.hash)} ` : 
        ''
      
      // Combine both lines into one with a separator
      const output = `${indexStr}${hash}${chalk.yellow(message)} └─ ${archive.name} • ${size} • ${chalk.green(author)}`
      
      // Add single line break between entries, but not after the last one
      console.log(output + (index < archives.length - 1 ? '\n' : ''))
    })
  },

  async info(args) {
    const archives = await getArchives()
    if (archives.length === 0) {
      console.log('No archives found')
      return
    }

    let archive
    if (args._.length > 1) {
      const { archive: ref } = parseArchivePath(args._[1])
      archive = await findArchive(ref)
    } else {
      // No argument - show most recent
      archive = archives[0]
    }

    // Get file info
    const size = formatSize(archive.size)

    // Get archive contents
    const tempDir = path.join(ARCHIVE_DIR, 'temp-info')
    let contents = []
    try {
      // Create temp directory
      mkdirSync(tempDir, { recursive: true })
      
      // Decrypt archive
      execCmd(`gpg -q --yes -d -o "${path.join(tempDir, 'temp.tar')}" "${path.join(ARCHIVE_DIR, archive.name)}"`)
      
      // List contents
      const fileList = execCmd(`cd "${tempDir}" && tar tvf temp.tar`)
      contents = fileList.split('\n')
        .filter(Boolean)
        .map(line => {
          const parts = line.split(/\s+/)
          const size = parts[2]
          const date = `${parts[3]} ${parts[4]}`
          const name = parts.slice(5).join(' ')
          return { size, date, name }
        })
    } finally {
      // Clean up
      execCmd(`rm -rf "${tempDir}"`)
    }

    if (args.json) {
      console.log(JSON.stringify({
        name: archive.name,
        size: archive.size,
        git: archive.git,
        files: contents
      }, null, 2))
      return
    }

    // Display info
    const message = archive.git?.message || 'no commit info'
    const author = archive.git?.author || 'unknown'
    const hash = archive.git?.hash ? `${chalk.blue(archive.git.hash)} ` : ''
    console.log(`${hash}${chalk.yellow(message)}
└─ ${archive.name} • ${size} • ${chalk.green(author)}`)

    // Show archive contents
    console.log(`\n${chalk.gray('contents:')}`)
    contents.forEach(file => {
      console.log(`   ${chalk.gray(file.size.padEnd(8))} ${chalk.gray(file.date.padEnd(16))} ${file.name}`)
    })
  },

  async cat(args) {
    if (args._.length < 2) {
      console.error('Usage: cat [options] <archive-path>')
      process.exit(1)
    }

    const { archive: ref, filePath } = parseArchivePath(args._[1])
    const archive = await findArchive(ref)
    const tempDir = path.join(ARCHIVE_DIR, 'temp-cat')

    try {
      mkdirSync(tempDir, { recursive: true })
      execCmd(`gpg -q --yes -d -o "${path.join(tempDir, 'temp.tar')}" "${path.join(ARCHIVE_DIR, archive.name)}"`)
      
      // Extract all files
      execCmd(`cd "${tempDir}" && tar xf temp.tar`)

      // Get all command line options except the archive reference
      const options = process.argv.slice(3).filter(arg => arg !== args._[1])
      
      // Handle both glob patterns and direct file paths
      let files
      if (filePath.includes('*') || filePath.includes('?')) {
        // Use find for glob patterns
        files = execCmd(`cd "${tempDir}" && find . -name "${filePath}" -type f`).split('\n').filter(Boolean)
      } else {
        // Direct file path - strip leading ./ if present
        const targetPath = filePath.startsWith('./') ? filePath.slice(2) : filePath
        const fullPath = path.join(tempDir, targetPath)
        files = existsSync(fullPath) ? [`./${targetPath}`] : []
      }
      
      if (files.length === 0) {
        console.error(`No files matching: ${filePath}`)
        return
      }

      // Cat each matching file
      for (const file of files) {
        if (files.length > 1) {
          console.log(`\n==> ${file.slice(2)} <==`)
        }
        const output = execCmd(`cat ${options.join(' ')} "${path.join(tempDir, file)}"`)
        if (output) {
          console.log(output)
        }
      }
    } finally {
      execCmd(`rm -rf "${tempDir}"`)
    }
  },

  async cp(args) {
    if (args._.length < 3) {
      console.error('Usage: cp [options] <archive-path> <destination>')
      process.exit(1)
    }

    const { archive: ref, filePath } = parseArchivePath(args._[1])
    const archive = await findArchive(ref)
    const dest = args._[2]
    const tempDir = path.join(ARCHIVE_DIR, 'temp-cp')

    try {
      mkdirSync(tempDir, { recursive: true })
      execCmd(`gpg -q --yes -d -o "${path.join(tempDir, 'temp.tar')}" "${path.join(ARCHIVE_DIR, archive.name)}"`)
      
      // Extract all files
      execCmd(`cd "${tempDir}" && tar xf temp.tar`)

      // Get all command line options except the source and dest
      const options = process.argv.slice(3)
        .filter(arg => arg !== args._[1] && arg !== args._[2])
      
      // Handle both glob patterns and direct file paths
      let files
      if (filePath.includes('*') || filePath.includes('?')) {
        // Use find for glob patterns
        files = execCmd(`cd "${tempDir}" && find . -name "${filePath}" -type f`).split('\n').filter(Boolean)
      } else {
        // Direct file path - strip leading ./ if present
        const targetPath = filePath.startsWith('./') ? filePath.slice(2) : filePath
        const fullPath = path.join(tempDir, targetPath)
        files = existsSync(fullPath) ? [`./${targetPath}`] : []
      }
      
      if (files.length === 0) {
        console.error(`No files matching: ${filePath}`)
        return
      }

      // Create destination directory if it doesn't exist
      mkdirSync(dest, { recursive: true })

      // Copy each matching file
      for (const file of files) {
        const fileName = path.basename(file)
        const destPath = path.join(dest, fileName)
        execCmd(`cp ${options.join(' ')} "${path.join(tempDir, file)}" "${destPath}"`)
        console.log(`Copied ${file.slice(2)} to ${destPath}`)
      }
    } finally {
      execCmd(`rm -rf "${tempDir}"`)
    }
  },

  async less(args) {
    if (args._.length < 2) {
      console.error('Usage: less [options] <archive-path>')
      process.exit(1)
    }

    const { archive: ref, filePath } = parseArchivePath(args._[1])
    const archive = await findArchive(ref)
    const tempDir = path.join(ARCHIVE_DIR, 'temp-less')

    try {
      mkdirSync(tempDir, { recursive: true })
      execCmd(`gpg -q --yes -d -o "${path.join(tempDir, 'temp.tar')}" "${path.join(ARCHIVE_DIR, archive.name)}"`)
      
      // Extract all files
      execCmd(`cd "${tempDir}" && tar xf temp.tar`)

      // Get all command line options except the archive reference
      const options = process.argv.slice(3).filter(arg => arg !== args._[1])
      
      // Handle both glob patterns and direct file paths
      let files
      if (filePath.includes('*') || filePath.includes('?')) {
        // Use find for glob patterns
        files = execCmd(`cd "${tempDir}" && find . -name "${filePath}" -type f`).split('\n').filter(Boolean)
      } else {
        // Direct file path - strip leading ./ if present
        const targetPath = filePath.startsWith('./') ? filePath.slice(2) : filePath
        const fullPath = path.join(tempDir, targetPath)
        files = existsSync(fullPath) ? [`./${targetPath}`] : []
      }
      
      if (files.length === 0) {
        console.error(`No files matching: ${filePath}`)
        return
      }

      // Less each matching file
      for (const file of files) {
        if (files.length > 1) {
          console.log(`\n==> ${file.slice(2)} <==`)
        }
        const output = execCmd(`less ${options.join(' ')} "${path.join(tempDir, file)}"`)
        if (output) {
          console.log(output)
        }
      }
    } finally {
      execCmd(`rm -rf "${tempDir}"`)
    }
  },

  async verify(args) {
    const archives = await getArchives()
    if (archives.length === 0) {
      console.log('No archives found')
      return
    }

    let targetArchives = []
    if (args._.length > 1) {
      const { archive: ref } = parseArchivePath(args._[1])
      const archive = await findArchive(ref)
      targetArchives = [archive]
    } else {
      targetArchives = [archives[0]]
    }

    const tmpDir = path.join(ARCHIVE_DIR, 'temp-verify')
    try {
      // Create temp directory
      mkdirSync(tmpDir, { recursive: true })

      const results = []
      let allValid = true

      for (const archive of targetArchives) {
        const tempFile = path.join(tmpDir, 'temp.tar')
        try {
          // Decrypt archive
          execCmd(`gpg -q --yes -d -o "${tempFile}" "${path.join(ARCHIVE_DIR, archive.name)}"`)
          
          // Verify tar contents
          execCmd(`tar tf "${tempFile}" >/dev/null 2>&1`)
          
          // Get commit info
          const commitInfo = execCmd(`git show --no-patch --format="%h%n%an <%ae>%n%at%n%s" ${archive.git.hash}`).split('\n')
          const [hash, author, timestamp, subject] = commitInfo
          const date = new Date(parseInt(timestamp) * 1000).toISOString()
            .replace(/[TZ]/g, ' ')
            .trim()

          results.push({ name: archive.name, valid: true })
          
          if (!args.json) {
            const size = formatSize(archive.size)
            console.log(`${chalk.green('✓')} ${chalk.yellow(subject)}
└─ ${archive.name} • ${size} • ${chalk.green(author)}
   ${chalk.gray('created:')} ${date}
   ${chalk.gray('commit:')}  ${hash}`)
          }
        } catch (error) {
          results.push({ name: archive.name, valid: false, error: error.message })
          allValid = false
          
          if (!args.json) {
            const size = formatSize(archive.size)
            console.log(`${chalk.red('✖')} ${chalk.yellow(archive.git.message)}
└─ ${archive.name} • ${size} • ${chalk.green(archive.git.author)}
   ${chalk.red('error:')} ${error.message}`)
          }
        } finally {
          // Clean up temp file
          execCmd(`rm -f "${tempFile}"`)
        }
      }

      if (args.json) {
        console.log(JSON.stringify({
          status: allValid ? 'success' : 'error',
          message: allValid ? 'all archives valid' : 'some archives failed verification',
          results
        }, null, 2))
      }

      if (!allValid) {
        process.exit(1)
      }
    } finally {
      // Clean up temp directory
      execCmd(`rm -rf "${tmpDir}"`)
    }
  },

  async restore(args) {
    const archives = await getArchives()
    if (archives.length === 0) {
      console.log('No archives found')
      return
    }

    let archive
    if (args._.length > 1) {
      const { archive: ref } = parseArchivePath(args._[1])
      archive = await findArchive(ref)
    } else {
      // Default to most recent committed archive
      const committedArchives = archives.filter(a => a.git?.hash)
      if (committedArchives.length === 0) {
        console.error('No committed archives found')
        return
      }
      archive = committedArchives[0]
    }

    try {
      // Clear private directory
      execCmd('rm -rf private')
      execCmd('mkdir -p private')

      // Decrypt and extract archive
      const tempTar = path.join(ARCHIVE_DIR, 'temp.tar')
      await spawnCmd('gpg', [
        '--yes',
        '-d',
        '-o', tempTar,
        path.join(ARCHIVE_DIR, archive.name)
      ])
      execCmd(`tar -xf "${tempTar}" -C private`)
      execCmd(`rm "${tempTar}"`)

      if (args.json) {
        console.log(JSON.stringify({ status: 'success', archive }, null, 2))
        return
      }

      const size = formatSize(archive.size)
      const message = archive.git?.message || 'no commit info'
      const author = archive.git?.author || 'unknown'
      const hash = archive.git?.hash ? `${chalk.blue(archive.git.hash)} ` : ''
      
      // Combined output with success message
      console.log(`${hash}${chalk.yellow(message)} └─ ${archive.name} • ${size} • ${chalk.green(author)}`)
      console.log(`\n${chalk.green('✓')} Successfully restored files to private directory`)
    } catch (error) {
      console.error(`Failed to restore: ${error.message}`)
      process.exit(1)
    }
  },

  async pack(args) {
    // Check if private directory exists and has files
    if (!existsSync(ARCHIVE_DIR)) {
      mkdirSync(ARCHIVE_DIR, { recursive: true })
    }
    if (!existsSync(PRIVATE_DIR)) {
      mkdirSync(PRIVATE_DIR, { recursive: true })
    }

    // Check if there are any files in private
    const files = readdirSync(PRIVATE_DIR)
    if (files.length === 0) {
      console.error('No files found in private directory')
      process.exit(1)
    }

    // Get latest archive
    const archives = readdirSync(ARCHIVE_DIR)
      .filter(f => f.endsWith('.tar.gpg'))
      .sort()
      .reverse()

    // Always create archive if no previous archive exists
    if (archives.length === 0 || args.force) {
      console.log('Creating encrypted archive...')
      execCmd('node bin/create-encrypted-archive.js', true)
      
      // Stage the new archive
      const latest = readdirSync(ARCHIVE_DIR)
        .filter(f => f.endsWith('.tar.gpg'))
        .sort()
        .reverse()[0]
      
      if (latest) {
        execCmd(`git add ".archives/${latest}"`)
        console.log(`\nStaged new archive: ${latest}`)
        console.log('\nTip: Run git commit -m "chore: add new archive" to save these changes')
      }
      return
    }

    // Compare latest archive contents with current private directory
    const latestArchive = archives[0]
    const tempDir = path.join(ARCHIVE_DIR, 'temp-compare')
    try {
      // Create temp directory
      mkdirSync(tempDir, { recursive: true })
      
      // Decrypt latest archive
      execCmd(`gpg --yes -d -o "${path.join(tempDir, 'temp.tar')}" "${path.join(ARCHIVE_DIR, latestArchive)}"`)
      execCmd(`cd "${tempDir}" && tar xf temp.tar`)

      // Compare directories
      const diff = execCmd(`diff -r "${tempDir}/private" "${PRIVATE_DIR}" 2>&1 || true`)
      if (!diff) {
        console.error('No changes detected in private directory. Use --force to create archive anyway.')
        process.exit(1)
      }

      // Changes detected, create new archive
      console.log('Changes detected. Creating encrypted archive...')
      execCmd('node bin/create-encrypted-archive.js', true)
      
      // Stage the new archive
      const latest = readdirSync(ARCHIVE_DIR)
        .filter(f => f.endsWith('.tar.gpg'))
        .sort()
        .reverse()[0]
      
      if (latest) {
        execCmd(`git add ".archives/${latest}"`)
        console.log(`\nStaged new archive: ${latest}`)
        console.log('\nTip: Run git commit -m "chore: add new archive" to save these changes')
      }
    } finally {
      // Clean up temp directory
      execCmd(`rm -rf "${tempDir}"`)
    }
  },

  async clean(args) {
    const archives = await getArchives()
    if (archives.length === 0) {
      console.log('No archives found')
      return
    }

    // Get list of uncommitted archives
    const uncommitted = execCmd('git ls-files --others --exclude-standard -- .archives/*.tar.gpg').split('\n').filter(Boolean)
    
    if (uncommitted.length <= 1) {
      console.log('No cleanup needed - at most one uncommitted archive')
      return
    }

    // Keep only the most recent uncommitted archive
    const latest = uncommitted.sort().reverse()[0]
    for (const archive of uncommitted) {
      if (archive !== latest) {
        unlinkSync(path.join(ARCHIVE_DIR, archive))
        console.log(`Removed ${archive}`)
      }
    }

    console.log(`\nCleanup complete. Kept most recent uncommitted archive: ${latest}\n`)
    console.log('Tip: Run git commit -m "chore: clean up uncommitted archives" to save these changes')
  }
}

// Parse command line arguments
const args = minimist(process.argv.slice(2), {
  string: ['_'], // Treat all positional arguments as strings
  boolean: ['help', 'h'] // Treat --help and -h as boolean flags
})
const command = args._[0] || 'help'

// Help command
function generateHelp(cmd) {
  if (cmd && COMMANDS[cmd]) {
    const command = COMMANDS[cmd]
    console.log(`${command.desc}
Usage: ${command.usage}`)

    if (command.options?.length) {
      console.log('\nOptions:')
      command.options.forEach(([opt, desc]) => {
        console.log(`  ${opt.padEnd(15)} ${desc}`)
      })
    }

    console.log('\nExamples:')
    command.examples.forEach(([ex, desc]) => {
      console.log(`  ${ex.padEnd(25)} ${chalk.gray('# ' + desc)}`)
    })
  } else {
    console.log(`${chalk.yellow('Usage')}
  <command> [options]

${chalk.yellow('Commands')}`)
    Object.entries(COMMANDS).forEach(([name, cmd]) => {
      console.log(`  ${chalk.green(name.padEnd(12))} ${chalk.gray(cmd.desc)}`)
    })
    console.log(`\nUse ${chalk.green('<command> --help')} for detailed help on a command`)
  }
}

// Run command
async function main() {
  try {
    // Show help if no command or explicit help requested
    if (!command || command === 'help') {
      generateHelp()
      return
    }

    // Show command-specific help if --help or -h flag is present
    if (args.help || args.h) {
      if (COMMANDS[command]) {
        generateHelp(command)
      } else {
        console.error(`Unknown command: ${command}`)
        generateHelp()
      }
      return
    }

    // Execute command
    if (COMMANDS[command]) {
      await commands[command](args)
    } else {
      console.error(`Unknown command: ${command}`)
      generateHelp()
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

main() 