const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { GridFSBucket, ObjectId } = require('mongodb');
const cors = require('cors');
const path = require('path');
const Anime = require('./models/Anime');
const Episode = require('./models/Episode');
const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Routes for HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'User.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Admin.html'));
});

// Favicon route - prevent 404
app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

// Database Connection
const mongoURI = 'mongodb://127.0.0.1:27017/OnePiece'; // Change 'one piece' if you want
mongoose.connect(mongoURI);

const connection = mongoose.connection;
let gfsBucket;

connection.once('open', () => {
    gfsBucket = new GridFSBucket(connection.db, {
        bucketName: 'videos'
    });
    console.log('MongoDB Connected and GridFS Ready.');
});

// Multer Setup - use memory storage (better for large files)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// API: Create Anime Series
app.post('/api/anime', async (req, res) => {
    try {
        const { title, description } = req.body;
        
        if (!title) {
            return res.status(400).json({ message: 'Title is required' });
        }

        const anime = new Anime({ title, description });
        await anime.save();
        
        res.status(201).json({
            message: 'Anime series created successfully',
            anime
        });
    } catch (error) {
        console.error('Create Anime Error:', error);
        res.status(500).json({ message: 'Error creating anime series' });
    }
});

// API: Get All Anime Series
app.get('/api/anime', async (req, res) => {
    try {
        const animeList = await Anime.find().sort({ createdAt: -1 });
        res.json(animeList);
    } catch (error) {
        console.error('Get Anime Error:', error);
        res.status(500).json({ message: 'Error fetching anime series' });
    }
});

// API: Upload Episode
app.post('/api/upload', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No video file uploaded.' });

    const { animeId, episodeNumber, title } = req.body;

    if (!animeId || !episodeNumber || !title) {
        return res.status(400).json({ message: 'animeId, episodeNumber, and title are required' });
    }

    try {
        const uploadStream = gfsBucket.openUploadStream(req.file.originalname, {
            contentType: req.file.mimetype,
        });

        uploadStream.end(req.file.buffer);

        uploadStream.on('finish', async () => {
            try {
                const files = await gfsBucket.find({ filename: req.file.originalname }).toArray();
                if (!files || files.length === 0) {
                    return res.status(404).json({ message: 'File not found after upload' });
                }
                
                const file = files[0];

                // Create episode record
                const episode = new Episode({
                    animeId,
                    episodeNumber: parseInt(episodeNumber),
                    title,
                    filename: file.filename,
                    fileId: file._id.toString(),
                    size: file.length,
                    contentType: file.contentType
                });

                await episode.save();

                return res.status(201).json({
                    message: 'Episode uploaded successfully',
                    episode
                });
            } catch (error) {
                console.error('Episode Save Error:', error);
                res.status(500).json({ message: 'Error saving episode' });
            }
        });

        uploadStream.on('error', (err) => {
            console.error('Upload Error:', err);
            res.status(500).json({ message: 'Error uploading video' });
        });
    } catch (error) {
        console.error('Upload Stream Error:', error);
        res.status(500).json({ message: 'Error creating upload stream' });
    }
});

// API: Get Episodes by Anime ID
app.get('/api/episodes/:animeId', async (req, res) => {
    try {
        const episodes = await Episode.find({ animeId: req.params.animeId })
            .sort({ episodeNumber: 1 });
        res.json(episodes);
    } catch (error) {
        console.error('Get Episodes Error:', error);
        res.status(500).json({ message: 'Error fetching episodes' });
    }
});

// API: Get All Episodes with Anime Info
app.get('/api/episodes', async (req, res) => {
    try {
        const episodes = await Episode.find()
            .populate('animeId', 'title')
            .sort({ uploadedAt: -1 });
        res.json(episodes);
    } catch (error) {
        console.error('Get All Episodes Error:', error);
        res.status(500).json({ message: 'Error fetching episodes' });
    }
});

// API: Stream Video by Filename with range support
app.get('/video/:filename', async (req, res) => {
    try {
        const file = await gfsBucket.find({ filename: req.params.filename }).toArray();
        if (!file || file.length === 0) {
            return res.status(404).send('Video not found');
        }

        const fileSize = file[0].length;
        const range = req.headers.range;

        if (range) {
            // Parse range request
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = (end - start) + 1;

            // Set headers for range request
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': file[0].contentType,
            });

            // Stream the requested range
            const downloadStream = gfsBucket.openDownloadStreamByName(req.params.filename, { start, end: end + 1 });
            downloadStream.pipe(res);
        } else {
            // No range, stream entire file
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': file[0].contentType,
                'Accept-Ranges': 'bytes',
            });
            const downloadStream = gfsBucket.openDownloadStreamByName(req.params.filename);
            downloadStream.pipe(res);
        }

    } catch (error) {
        console.error('Stream Error:', error);
        res.status(500).send('Error streaming video');
    }
});

// API: Delete Episode by ID
app.delete('/api/episode/:id', async (req, res) => {
    try {
        const episode = await Episode.findById(req.params.id);
        
        if (!episode) {
            return res.status(404).json({ message: 'Episode not found' });
        }

        // Delete from GridFS
        await gfsBucket.delete(new ObjectId(episode.fileId));
        
        // Delete episode record
        await Episode.findByIdAndDelete(req.params.id);
        
        res.json({ message: 'Episode deleted successfully' });
    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ message: 'Error deleting episode' });
    }
});

// API: Delete Anime Series
app.delete('/api/anime/:id', async (req, res) => {
    try {
        // Find all episodes for this anime
        const episodes = await Episode.find({ animeId: req.params.id });
        
        // Delete all videos from GridFS
        for (const episode of episodes) {
            try {
                await gfsBucket.delete(new ObjectId(episode.fileId));
            } catch (err) {
                console.error('Error deleting file:', err);
            }
        }
        
        // Delete all episode records
        await Episode.deleteMany({ animeId: req.params.id });
        
        // Delete anime series
        await Anime.findByIdAndDelete(req.params.id);
        
        res.json({ message: 'Anime series and all episodes deleted successfully' });
    } catch (error) {
        console.error('Delete Anime Error:', error);
        res.status(500).json({ message: 'Error deleting anime series' });
    }
});

// Legacy API endpoints (keep for backward compatibility)
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).send('No video file uploaded.');

  const uploadStream = gfsBucket.openUploadStream(req.file.originalname, {
      contentType: req.file.mimetype,
  });

  uploadStream.end(req.file.buffer);

  uploadStream.on('finish', async () => {
      try {
          const files = await gfsBucket.find({ filename: req.file.originalname }).toArray();
          if (!files || files.length === 0) {
              return res.status(404).json({ message: 'File not found after upload' });
          }
          const file = files[0];
          return res.status(201).json({
              message: 'Video uploaded successfully',
              file: {
                  _id: file._id,
                  filename: file.filename,
                  contentType: file.contentType,
                  length: file.length,
              },
          });
      } catch (error) {
          console.error('Find Error:', error);
          res.status(500).send('Error retrieving uploaded video');
      }
  });

  uploadStream.on('error', (err) => {
      console.error('Upload Error:', err);
      res.status(500).send('Error uploading video');
  });
});

app.get('/videos', async (req, res) => {
    try {
        const files = await gfsBucket.find().toArray();
        if (!files || files.length === 0) {
            return res.status(404).json({ message: 'No videos found' });
        }
        res.json(files);
    } catch (error) {
        console.error('List Error:', error);
        res.status(500).send('Error listing videos');
    }
});

app.delete('/delete/:id', async (req, res) => {
    try {
        await gfsBucket.delete(new ObjectId(req.params.id));
        res.json({ message: 'Video deleted successfully' });
    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).send('Error deleting video');
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running at http://10.9.9.28:${PORT}`);
});
