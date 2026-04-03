console.log(`
  tunn3l installed!

  HTTP tunnel:
    tunn3l http 3000

  SSH tunnel:
    tunn3l ssh

  Always-on (starts on boot):
    tunn3l daemon install --port 3000
    tunn3l daemon start

  More: tunn3l --help
`)
