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
        profile_pic TEXT,
        bio TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reels (
        id SERIAL PRIMARY KEY,
        video_id VARCHAR(255) NOT NULL,
        username VARCHAR(100) NOT NULL,
        description TEXT,
        is_approved BOOLEAN DEFAULT FALSE,
        likes INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE reels ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        reel_id INTEGER REFERENCES reels(id) ON DELETE CASCADE,
        username VARCHAR(100) NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS banners (
        id SERIAL PRIMARY KEY,
        image_base64 TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database initialized: users, reels, comments, and banners tables are ready.');
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
        profile_pic: user.profile_pic,
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

// Upload Profile Picture Endpoint
app.put('/api/users/profile-pic', async (req, res) => {
  const { email, profile_pic } = req.body;
  
  if (!email || !profile_pic) {
    return res.status(400).json({ error: 'Email and profile_pic are required' });
  }

  try {
    const result = await pool.query(
      'UPDATE users SET profile_pic = $1 WHERE email = $2 RETURNING id',
      [profile_pic, email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'Profile picture updated successfully' });
  } catch (error) {
    console.error('Update profile pic error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Bio Endpoint
app.put('/api/users/bio', async (req, res) => {
  const { email, bio } = req.body;
  if (!email || bio === undefined) {
    return res.status(400).json({ error: 'Email and bio are required' });
  }
  try {
    const result = await pool.query(
      'UPDATE users SET bio = $1 WHERE email = $2 RETURNING id',
      [bio, email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'Bio updated successfully' });
  } catch (error) {
    console.error('Update bio error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search Users Endpoint
app.get('/api/users/search', async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.json([]);
  }
  try {
    // Search by name (case-insensitive)
    const result = await pool.query(
      'SELECT name as username, profile_pic FROM users WHERE name ILIKE $1 LIMIT 20',
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get User Profile Endpoint
app.get('/api/users/profile/:username', async (req, res) => {
  const { username } = req.params;
  try {
    // 1. Get user details
    const userResult = await pool.query(
      'SELECT name, bio, profile_pic FROM users WHERE name = $1',
      [username]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // 2. Get user's approved reels
    const reelsResult = await pool.query(
      'SELECT * FROM reels WHERE username = $1 AND is_approved = TRUE ORDER BY created_at DESC',
      [username]
    );

    res.json({
      user: {
        username: user.name,
        bio: user.bio,
        profile_pic: user.profile_pic,
      },
      reels: reelsResult.rows,
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get comments for a reel
app.get('/api/reels/:id/comments', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM comments WHERE reel_id = $1 ORDER BY created_at DESC',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Fetch comments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Post a comment to a reel
app.post('/api/reels/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { username, text } = req.body;
  if (!username || !text) {
    return res.status(400).json({ error: 'Username and text are required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO comments (reel_id, username, text) VALUES ($1, $2, $3) RETURNING *',
      [id, username, text]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Post comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Likes Endpoint
app.put('/api/reels/:id/like', async (req, res) => {
  const { id } = req.params;
  const { action } = req.body;
  
  if (!['like', 'unlike'].includes(action)) {
    return res.status(400).json({ error: 'Action must be "like" or "unlike"' });
  }

  try {
    let query = '';
    if (action === 'like') {
      query = 'UPDATE reels SET likes = likes + 1 WHERE id = $1 RETURNING likes';
    } else {
      query = 'UPDATE reels SET likes = GREATEST(likes - 1, 0) WHERE id = $1 RETURNING likes';
    }
    
    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reel not found' });
    }
    
    res.json({ likes: result.rows[0].likes });
  } catch (error) {
    console.error('Like error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;

// Get Approved Reels Endpoint
app.get('/api/reels', async (req, res) => {
  try {
    // Fetch only approved reels with their comment count, newest first
    const query = `
      SELECT r.*, 
             (SELECT COUNT(*) FROM comments c WHERE c.reel_id = r.id) as comment_count 
      FROM reels r 
      WHERE r.is_approved = TRUE 
      ORDER BY r.created_at DESC
    `;
    const result = await pool.query(query);
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

// Get Banners Endpoint
app.get('/api/banners', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM banners ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching banners:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/banners', adminAuth, async (req, res) => {
  const { image_base64 } = req.body;
  if (!image_base64) return res.status(400).json({ error: 'Image is required' });
  try {
    await pool.query('INSERT INTO banners (image_base64) VALUES ($1)', [image_base64]);
    res.status(201).json({ message: 'Banner added successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add banner' });
  }
});

app.delete('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM banners WHERE id = $1', [req.params.id]);
    res.json({ message: 'Banner deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete banner' });
  }
});

app.get('/admin', adminAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Santgram Admin Panel</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap');
        
        :root {
          --bg-main: #0f172a;
          --bg-card: rgba(30, 41, 59, 0.7);
          --text-main: #f8fafc;
          --text-muted: #94a3b8;
          --accent: #f97316;
          --accent-hover: #ea580c;
          --success: #10b981;
          --danger: #ef4444;
        }

        body { 
          font-family: 'Outfit', sans-serif; 
          padding: 40px 20px; 
          background: var(--bg-main); 
          color: var(--text-main);
          max-width: 900px; 
          margin: auto; 
          min-height: 100vh;
        }

        h2 { font-size: 2.5rem; font-weight: 800; background: linear-gradient(to right, #f97316, #fcd34d); -webkit-background-clip: text; color: transparent; margin-bottom: 40px; text-align: center; }
        h3 { font-size: 1.5rem; color: var(--text-main); margin-bottom: 20px; border-bottom: 2px solid rgba(255,255,255,0.1); padding-bottom: 10px; }
        h4 { margin: 0 0 15px 0; color: var(--text-main); font-weight: 600; }

        .card { 
          background: var(--bg-card); 
          padding: 20px; 
          margin-bottom: 16px; 
          border-radius: 16px; 
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2); 
          border: 1px solid rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          display: flex; 
          align-items: center; 
          justify-content: space-between;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        
        .card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3); }

        .btn { 
          padding: 10px 20px; 
          border: none; 
          border-radius: 8px; 
          cursor: pointer; 
          color: white; 
          font-weight: 600;
          font-family: 'Outfit', sans-serif;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        
        .btn:hover { transform: scale(1.05); }
        .btn:active { transform: scale(0.95); }

        .btn-approve { background: var(--success); box-shadow: 0 4px 14px rgba(16, 185, 129, 0.3); }
        .btn-approve:hover { background: #059669; }
        
        .btn-reject { background: var(--danger); box-shadow: 0 4px 14px rgba(239, 68, 68, 0.3); margin-left: 10px; }
        .btn-reject:hover { background: #dc2626; }
        
        .btn-primary { background: var(--accent); box-shadow: 0 4px 14px rgba(249, 115, 22, 0.3); }
        .btn-primary:hover { background: var(--accent-hover); }

        hr { border: 0; height: 1px; background: rgba(255, 255, 255, 0.1); margin: 40px 0; }
        
        input[type="file"] {
          background: rgba(255,255,255,0.05);
          padding: 10px;
          border-radius: 8px;
          color: var(--text-muted);
          border: 1px dashed rgba(255,255,255,0.2);
          width: 100%;
          box-sizing: border-box;
          margin-bottom: 15px;
        }
      </style>
    </head>
    <body>
      <h2>Santgram Admin Panel</h2>
      
      <h3>Pending Videos (Requires Approval)</h3>
      <div id="reels">Loading...</div>

      <hr style="margin: 40px 0;">

      <h3>Banner Management</h3>
      <div class="card" style="display: block;">
        <h4>Upload New Banner</h4>
        <input type="file" id="bannerFile" accept="image/*" />
        <button class="btn btn-primary" onclick="uploadBanner()">Upload Banner</button>
      </div>
      <div id="banners" style="display: flex; flex-wrap: wrap; gap: 10px;">Loading banners...</div>

      <hr style="margin: 40px 0;">

      <h3>Approved Videos (Live on App)</h3>
      <div id="approved-reels">Loading...</div>

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
        
        async function loadApproved() {
          const res = await fetch('/api/admin/approved-reels');
          const reels = await res.json();
          const container = document.getElementById('approved-reels');
          container.innerHTML = '';
          if (reels.length === 0) {
             container.innerHTML = '<p>No approved videos yet.</p>';
             return;
          }
          reels.forEach(r => {
            const videoId = extractYoutubeId(r.video_id);
            const div = document.createElement('div');
            div.className = 'card';
            div.innerHTML = \`
              <div>
                <strong>\${r.username}</strong><br>
                <div style="margin: 10px 0;">
                  <iframe width="280" height="157" src="https://www.youtube.com/embed/\${videoId}" frameborder="0" allowfullscreen></iframe>
                </div>
                <small>\${r.description}</small>
              </div>
              <div style="display: flex; flex-direction: column; gap: 10px;">
                <button class="btn btn-reject" onclick="removeReel(\${r.id})" style="margin-left: 0;">Remove Video</button>
              </div>
            \`;
            container.appendChild(div);
          });
        }
        
        async function approve(id) {
          await fetch('/api/admin/approve-reel/' + id, { method: 'PUT' });
          loadPending();
          loadApproved();
        }
        
        async function reject(id) {
          if (confirm("Are you sure you want to reject and delete this video?")) {
            await fetch('/api/admin/reject-reel/' + id, { method: 'DELETE' });
            loadPending();
          }
        }

        async function removeReel(id) {
          if (confirm("Are you sure you want to permanently delete this approved video from the app?")) {
            await fetch('/api/admin/remove-reel/' + id, { method: 'DELETE' });
            loadApproved();
          }
        }
        
        async function loadBanners() {
          const res = await fetch('/api/banners');
          const banners = await res.json();
          const container = document.getElementById('banners');
          container.innerHTML = '';
          if (banners.length === 0) {
             container.innerHTML = '<p>No active banners.</p>';
             return;
          }
          banners.forEach(b => {
            const div = document.createElement('div');
            div.className = 'card';
            div.style.flexDirection = 'column';
            div.style.width = '200px';
            div.innerHTML = \`
              <img src="data:image/jpeg;base64,\${b.image_base64}" style="width:100%; border-radius:4px; margin-bottom:10px;">
              <button class="btn btn-reject" onclick="deleteBanner(\${b.id})">Delete Banner</button>
            \`;
            container.appendChild(div);
          });
        }

        async function uploadBanner() {
          const fileInput = document.getElementById('bannerFile');
          if (!fileInput.files[0]) return alert('Please select an image first.');
          const reader = new FileReader();
          reader.onload = async function() {
            const base64String = reader.result.split(',')[1];
            await fetch('/api/admin/banners', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image_base64: base64String })
            });
            fileInput.value = '';
            loadBanners();
          };
          reader.readAsDataURL(fileInput.files[0]);
        }

        async function deleteBanner(id) {
          if (confirm("Are you sure you want to delete this banner?")) {
            await fetch('/api/admin/banners/' + id, { method: 'DELETE' });
            loadBanners();
          }
        }
        
        loadPending();
        loadApproved();
        loadBanners();
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

app.get('/api/admin/approved-reels', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reels WHERE is_approved = TRUE ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/admin/remove-reel/:id', adminAuth, async (req, res) => {
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
