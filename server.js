const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const { AssemblyAI } = require('assemblyai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3000;

// AssemblyAI client
const client = new AssemblyAI({
  apiKey: "35672e1be98b4fb3887856e58b55e2e5"
});

// ── Dev-only live reload ────────────────────────────────────────────
// Watches public/ for changes; when something saves, the LiveReload
// server pings the connected webviews over WebSocket and they refresh
// themselves. Stop-gap until the Vite migration in TAURI_PORT.md.
// Disabled when NODE_ENV=production so the prod binary doesn't ship a
// 35344 listener or inject the snippet.
if (process.env.NODE_ENV !== 'production') {
  const livereload = require('livereload');
  const connectLivereload = require('connect-livereload');
  const lrServer = livereload.createServer({
    exts: ['html', 'css', 'js'],
    delay: 80,
  });
  lrServer.watch(path.join(__dirname, 'public'));
  app.use(connectLivereload());
  console.log('🔁  Live reload active — watching public/ on ws://localhost:35729');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadsDir);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /\.(mp3|wav|m4a|mp4|mov|avi|mkv|flv|wmv|webm|ogg|aac|flac)$/i;
    if (allowedTypes.test(file.originalname)) {
      return cb(null, true);
    }
    cb(new Error('Invalid file type. Please upload audio or video files only.'));
  }
});

// Store transcription jobs in memory (in production, use a database)
const transcriptionJobs = new Map();

// Helper function to extract audio from video files
const extractAudio = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .output(outputPath)
      .audioCodec('libmp3lame')
      .audioFrequency(16000)
      .audioChannels(1)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
};

// Upload and transcribe endpoint
app.post('/api/transcribe', upload.single('audioFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = Date.now().toString();
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    
    // Initialize job status
    transcriptionJobs.set(jobId, {
      status: 'processing',
      fileName: fileName,
      progress: 0,
      transcript: null,
      error: null
    });

    res.json({ jobId, message: 'File uploaded successfully. Transcription started.' });

    // Process file asynchronously
    processTranscription(jobId, filePath, fileName);

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Process transcription
async function processTranscription(jobId, filePath, fileName) {
  try {
    let audioPath = filePath;
    
    // Check if it's a video file and extract audio
    const videoExtensions = /\.(mp4|mov|avi|mkv|flv|wmv|webm)$/i;
    if (videoExtensions.test(fileName)) {
      transcriptionJobs.set(jobId, {
        ...transcriptionJobs.get(jobId),
        status: 'extracting_audio',
        progress: 10
      });
      
      const audioOutputPath = filePath.replace(path.extname(filePath), '_extracted.mp3');
      await extractAudio(filePath, audioOutputPath);
      audioPath = audioOutputPath;
    }

    // Update status to uploading
    transcriptionJobs.set(jobId, {
      ...transcriptionJobs.get(jobId),
      status: 'uploading',
      progress: 30
    });

    // Upload file to AssemblyAI
    const audioFile = await client.files.upload(audioPath);

    // Update status to transcribing
    transcriptionJobs.set(jobId, {
      ...transcriptionJobs.get(jobId),
      status: 'transcribing',
      progress: 50
    });

    // Start transcription
    const transcript = await client.transcripts.transcribe({
      audio: audioFile,
      speech_model: 'best'
    });

    // Update with final result
    transcriptionJobs.set(jobId, {
      ...transcriptionJobs.get(jobId),
      status: 'completed',
      progress: 100,
      transcript: transcript.text
    });

    // Clean up files
    await fs.remove(filePath);
    if (audioPath !== filePath) {
      await fs.remove(audioPath);
    }

  } catch (error) {
    console.error('Transcription error:', error);
    transcriptionJobs.set(jobId, {
      ...transcriptionJobs.get(jobId),
      status: 'error',
      error: error.message
    });
  }
}

// Get transcription status
app.get('/api/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = transcriptionJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
});

// Get all jobs
app.get('/api/jobs', (req, res) => {
  const jobs = Array.from(transcriptionJobs.entries()).map(([id, job]) => ({
    id,
    ...job
  }));
  res.json(jobs);
});

// Delete job
app.delete('/api/jobs/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  if (transcriptionJobs.has(jobId)) {
    transcriptionJobs.delete(jobId);
    res.json({ message: 'Job deleted successfully' });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Ready to transcribe audio and video files!');
});
