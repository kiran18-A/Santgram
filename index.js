const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize PostgreSQL connection pool
// Render injects the DATABASE_URL environment variable automatically
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for some Render connections
  },
});

// Automatically create the users and reels tables if they don't exist
const initializeDatabase = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reels (
        id SERIAL PRIMARY KEY,
        video_id VARCHAR(255) NOT NULL,
        username VARCHAR(100) NOT NULL,
        description TEXT,
        is_approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database initialized: users and reels tables are ready.');
  } catch (err) {
    console.error('Failed to initialize database:', err);
  }
};
initializeDatabase();

// Basic health check endpoint
app.get('/', (req, res) => {
  res.send('Santgram API is running!');
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Check if user exists
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = userResult.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Success! (In a real app, you would generate and return a JWT token here)
    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Signup Endpoint
app.post('/api/signup', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required' });
  }

  try {
    // Check if user already exists
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    // Hash the password securely
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Insert new user into database
    const newUser = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, passwordHash, name]
    );

    res.status(201).json({
      message: 'User created successfully',
      user: newUser.rows[0],
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;

// Get Approved Reels Endpoint
app.get('/api/reels', async (req, res) => {
  try {
    // Fetch only approved reels, newest first
    const result = await pool.query('SELECT * FROM reels WHERE is_approved = TRUE ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching reels:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Post New Reel Endpoint
app.post('/api/reels', async (req, res) => {
  const { video_id, username, description } = req.body;

  if (!video_id || !username) {
    return res.status(400).json({ error: 'Video ID and username are required' });
  }

  try {
    const newReel = await pool.query(
      'INSERT INTO reels (video_id, username, description) VALUES ($1, $2, $3) RETURNING *',
      [video_id, username, description || '']
    );

    res.status(201).json({
      message: 'Video submitted successfully! It will appear once approved by an admin.',
      reel: newReel.rows[0],
    });
  } catch (error) {
    console.error('Error posting reel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- ADMIN PANEL SECURE ROUTES ---

const adminAuth = (req, res, next) => {
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  const adminPassword = process.env.ADMIN_PASSWORD || 'SantgramAdmin123';
  if (login && password && login === 'admin' && password === adminPassword) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Authentication required.');
};

app.get('/admin', adminAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Santgram Admin Panel</title>
      <style>
        body { font-family: sans-serif; padding: 20px; background: #f4f4f9; max-width: 800px; margin: auto; }
        .card { background: white; padding: 15px; margin-bottom: 10px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: space-between; }
        .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; color: white; font-weight: bold; }
        .btn-approve { background: #4CAF50; }
        .btn-reject { background: #f44336; margin-left: 10px; }
      </style>
    </head>
    <body>
      <h2>Santgram Admin Panel - Pending Videos</h2>
      <div id="reels">Loading...</div>
      <script>
        function extractYoutubeId(url) {
          if (!url || typeof url !== 'string') return '';
          if (!url.includes('http')) return url;
          const regExp = /^.*(youtu.be\\/|v\\/|u\\/\\w\\/|embed\\/|watch\\?v=|\\&v=)([^#\\&\\?]*).*/;
          const match = url.match(regExp);
          return (match && match[2].length === 11) ? match[2] : url;
        }

        async function loadPending() {
          const res = await fetch('/api/admin/pending-reels');
          const reels = await res.json();
          const container = document.getElementById('reels');
          container.innerHTML = '';
          if (reels.length === 0) {
             container.innerHTML = '<p>No pending videos to approve.</p>';
             return;
          }
          reels.forEach(r => {
            const videoId = extractYoutubeId(r.video_id);
            const div = document.createElement('div');
            div.className = 'card';
            div.innerHTML = \`
              <div>
                <strong>\${r.username}</strong> submitted video:<br>
                <div style="margin: 10px 0;">
                  <iframe width="280" height="157" src="https://www.youtube.com/embed/\${videoId}" frameborder="0" allowfullscreen></iframe>
                </div>
                <small>\${r.description}</small>
              </div>
              <div style="display: flex; flex-direction: column; gap: 10px;">
                <button class="btn btn-approve" onclick="approve(\${r.id})">Approve</button>
                <button class="btn btn-reject" onclick="reject(\${r.id})" style="margin-left: 0;">Reject</button>
              </div>
            \`;
            container.appendChild(div);
          });
        }
        
        async function approve(id) {
          await fetch('/api/admin/approve-reel/' + id, { method: 'PUT' });
          loadPending();
        }
        
        async function reject(id) {
          if (confirm("Are you sure you want to reject and delete this video?")) {
            await fetch('/api/admin/reject-reel/' + id, { method: 'DELETE' });
            loadPending();
          }
        }
        
        loadPending();
      </script>
    </body>
    </html>
  `);
});

app.get('/api/admin/pending-reels', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reels WHERE is_approved = FALSE ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/admin/approve-reel/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE reels SET is_approved = TRUE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/admin/reject-reel/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM reels WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
