const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const app = express();
var session = require('express-session');
var crypto = require('crypto');


app.set('view engine', 'ejs');
app.use(express.urlencoded({
    extended: true
}));
app.use(express.json());

//./run.sh

const db = new sqlite3.Database('./config/dict.db'); //šeit iestatīt datubāzes lokāciju

app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } //CHANGE IF HTTPS ENABLED!!!
}));

const requireAuth = (req, res, next) => {
    if (req.session.userId) {
        next(); // Lietotājs ir autentificēts, turpiniet ar nākamo starpprogrammatūru
    } else {
        res.redirect('/'); // Lietotājs nav autentificēts, novirzīt uz pieslēgšanās lapu
    }
}

const requireNoAuth = (req, res, next) => {
    if (req.session.userId) {
        res.redirect('/'); // Lietotājs ir autentificēts, novirzīt uz mājaslapu
    } else {
        next(); // Lietotājs nav autentificēts, turpināt ar nākamo starpprogrammatūru
    }
}

const requireAdmin = (req, res, next) => {
    const userId = req.session.userId;
    db.get('SELECT * FROM Users WHERE user_id = ? AND admin = 1', [userId], (err, row) => {
    if (err) {
        console.error('Error querying user:', err);
        res.status(500).send('Internal Server Error');
        return;
      }
      if (!row) {
          res.redirect('/'); //Lietotājs nav administrators, sūtīt uz mājaslapu
      } else {
          next(); // Lietotājs ir administrators, turpināt ar nākamo starpprogrammatūru
      }
    });
  };


app.use('/css', express.static(path.join(__dirname, 'public/css')));

app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/words', function(req, res) {
    res.sendFile(path.join(__dirname, 'public', 'wordlist.html'));
});

app.get('/signin', requireNoAuth, function(req, res) {
    res.sendFile(path.join(__dirname, 'public', 'signin.html'));
});

app.get('/signup', requireNoAuth, function(req, res) {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/add', requireAuth, requireAdmin, function(req, res) {
    res.sendFile(path.join(__dirname, 'public', 'add.html'));
});

app.get('/test', (req, res) => {
    res.send('It wrok!');
});

app.get('/search', (req, res) => {
    const userId = req.session.userId;
    const query = req.query.query;
    const like = `%${query}%`;
    const uniqueChars = extractHanCharacters(query);

    const wordSql = `
   SELECT * FROM Words
   WHERE (word LIKE ? OR reading LIKE ? OR meaning LIKE ?) ORDER BY word ASC, language ASC`;

    const baseCharSql = `
   SELECT * FROM Characters
   WHERE meaning LIKE ?
      OR reading_cn LIKE ?
      OR reading_kr LIKE ?
      OR reading_jp_on LIKE ?
      OR reading_jp_kun LIKE ?`;

    let charSql = baseCharSql;
    let params = [like, like, like, like, like];

    if (uniqueChars.length > 0) {
        const charCondition = uniqueChars.map(() => 'char = ?').join(' OR '); //jautajumzimes atkariba no simbolu skaita mekléjumå
        charSql += ` OR (${charCondition})`;
        params = [...params, ...uniqueChars];
    }

    db.all(wordSql, [like, like, like], (err1, wordResults) => {
        if (err1) return res.status(500).send('Word search failed');
        db.all(charSql, params, (err2, charResults) => {
          if (userId) { //logged in users
              db.all('SELECT * FROM Collections WHERE user_id = ?', [userId], (err, collections) => {
                if (err) {
                  console.error(err);
                  return res.status(500).send('Internal Server Error');
                }
                res.render('search', {
                  query,
                  words: wordResults,
                  characters: charResults,
                  collections
                });
              });
            } else { //logged out users
              res.render('search', {
                query,
                words: wordResults,
                characters: charResults,
                collections: []
              });
            }
        });
    });
});

app.get('/collections', requireAuth, (req, res) => {
  const userId = req.session.userId;

  db.all('SELECT * FROM Collections WHERE user_id = ? ORDER BY create_time DESC', [userId], (err, collections) => {
    if (err) {
      console.error('Error fetching user collections:', err);
      return res.status(500).send('Internal Server Error');
    }

    console.log(`Loaded ${collections.length} collections for user ID ${userId}`);

    collections.forEach(c => {
      c.created_at = formatTime(c.create_time);
    });
    res.render('mycollections.ejs', { collections });
  });
});

app.get('/collections/:id', requireAuth, (req,res) => { //dinamiski renderēt auga informācijas EJS veidni, kad tas tiek pieprasīts
    const collectionId = req.params.id;
    const userId = req.session.userId;

    db.get('SELECT * FROM Collections WHERE collection_id = ? AND user_id = ?', [collectionId, userId], (err, collection) => {
        if (err) {
            console.error('internal server error querying ID:', err);
            res.status(500).send('Internal Server Error'); //500 internal server error
            return;
        }
        if (!collection) {
            console.log('Collection not Found');
            res.status(404).send('404 Not Found'); //404 not found
            return;
        }

        db.all('SELECT Words.* FROM Words JOIN CollectionWords ON Words.word_id = CollectionWords.word_id WHERE CollectionWords.collection_id = ? ORDER BY word ASC, language ASC',
        [collectionId], (err, words) => { //paņemt visus vārdus no Words kuru wordid ir dotajā collection
            if (err) {
                console.error('Error fetching collection words in join:', err);
                return res.status(500).send('Internal Server Error');
            }

            const wordCount = words.length;
            const uniqueChars = new Set(); //set lai tikai pienemtu atskirigos chars

            words.forEach(word => {
              const chars = extractHanCharacters(word.word);
              chars.forEach(c => uniqueChars.add(c));
            });

            const charList = Array.from(uniqueChars); //parverst uz array lai vieglak stradat ar to
            console.log('charlist:', charList);
            const characterCount = charList.length;

            if (charList.length === 0) {
                return res.render('collection.ejs', { collection, words, characters: [], wordCount, characterCount });
            }

            const placeholders = charList.map(() => '?').join(', ');
            const sql = `SELECT * FROM Characters WHERE char IN (${placeholders})`;

            db.all(sql, charList, (err, characters) => {
              if (err) {
                console.error('Error fetching characters:', err);
                return res.status(500).send('Internal Server Error');
              }
            res.render('collection.ejs', { collection, words, characters, wordCount, characterCount });
            });
        });
      });
});

app.get('/collections/:id/export', requireAuth, (req, res) => {
  const collectionId = req.params.id;
  const userId = req.session.userId;

  db.get('SELECT * FROM Collections WHERE collection_id = ? AND user_id = ?', [collectionId, userId], (err, collection) => {
    if (err || !collection) {
      return res.status(404).send('Collection not found');
    }

    const sql = `
      SELECT Words.word, Words.reading, Words.meaning, Words.language
      FROM Words
      JOIN CollectionWords ON Words.word_id = CollectionWords.word_id
      WHERE CollectionWords.collection_id = ?
    `;

    db.all(sql, [collectionId], (err, words) => {
      if (err) {
        console.error('Error exporting collection:', err);
        return res.status(500).send('Internal Server Error');
      }

      // Build TSV string
      let content = '';
      const uniqueChars = new Set(); //set lai tikai pienemtu atskirigos chars

      words.forEach(w => {
        content += `${w.word}[${w.language}]\t${w.reading}<br>${w.meaning}\n`;
        const chars = extractHanCharacters(w.word);
        chars.forEach(c => uniqueChars.add(c));
      });
      const charList = Array.from(uniqueChars); //parverst uz array lai vieglak stradat ar to

      if (charList.length === 0) {
        const filename = sanitizeFilename(collection.name) + '.tsv';
        res.setHeader('Content-Type', 'text/tab-separated-values');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(content);
      }

      // Query Characters table
      const placeholders = charList.map(() => '?').join(', ');
      const charSql = `SELECT * FROM Characters WHERE char IN (${placeholders})`;

      db.all(charSql, charList, (err, characters) => {
        if (err) {
          console.error('Error fetching characters for export:', err);
          return res.status(500).send('Internal Server Error');
        }

        characters.forEach(c => {
            content += `${c.char}\t${c.meaning}<br><br> <b>Readings:</b><br> Mandarin: ${c.reading_cn} <br> Korean: ${c.reading_kr} <br> Kun'yomi: ${c.reading_jp_kun} <br> On'yomi: ${c.reading_jp_on}\n`;
        });

        const filename = sanitizeFilename(collection.name) + '.tsv';
        res.setHeader('Content-Type', 'text/tab-separated-values');       //headers for download
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(content);
      });
    });
  });
});


app.get('/worddata', (req, res) => { //lai ienestu visu words(Words) tabulu
    db.all('SELECT * FROM Words ORDER BY word ASC, language ASC', (err, rows) => { //kārto pēc vārda un tad valodu pārredzamībai
        if (err) {
            console.error(err.message);
            return res.status(500).send('Internal Server Error');
        }
        res.json(rows);
    });
});

app.get('/user', function (req, res) { //lai ienestu lietotāja datus, kur nepieciešams, sesijas laikā
    const userId = req.session.userId;
    if (!userId) {
        return res.json({ loggedIn: false });
    }
    db.get('SELECT username, admin, create_time FROM Users WHERE user_id = ?', [userId], (err, row) => {
        if (err) {
            console.error('internal server error querying ID:', err);
            res.status(500).send('Internal Server Error'); //500 internal server error
            return;
        }
        if (!row) {
            console.log('User not Found');
            return res.json({ loggedIn: false });
        }
        formattedCreateTime = formatTime(row.create_time);
        console.log('user: success!');
        res.setHeader('Content-Type', 'application/json');
        res.json({
            loggedIn: true,
            username: row.username,
            admin: row.admin,
            create_time: formattedCreateTime
        });
    });
});

app.get('/edit/word/:id', requireAuth, (req, res) => {
  const wordId = req.params.id;

  db.get('SELECT * FROM Words WHERE word_id = ?', [wordId], (err, row) => {
    if (err || !row) {
      return res.status(404).send('Word not found');
    }
    res.render('edit-word.ejs', { word: row });
  });
});

app.post('/edit/word/:id', requireAuth, (req, res) => {
  const wordId = req.params.id;
  const { reading, meaning } = req.body;

  db.run(
    'UPDATE Words SET reading = ?, meaning = ? WHERE word_id = ?',
    [reading, meaning, wordId],
    function (err) {
      if (err) {
        console.error('Failed to update word:', err);
        return res.status(500).send('Internal Server Error');
      }
      res.redirect('/search?query=' + encodeURIComponent(req.body.reading));
    }
  );
});


app.post('/validate', (req, res) => { //Verificēt vai ievadītie dati sakrīt ar kādu no pastāvošiem lietotājiem un uzsāk sesiju
    const username = req.body.username;
    const password = sha256(req.body.password);
    console.log(username, password);
    //console.log(datpix.foo());
    db.get('SELECT * FROM Users WHERE username = ? AND password = ?', [username, password], (err, row) => {
        if (err)  {
            console.error('internal server error after signin:', err);
            res.status(500).send('Internal Server Error'); //500 internal server error
            return;
        }
        if (!row) {
            console.log('Incorrect username or password');
            res.status(401).send('Nepareizs lietotājvārds vai parole'); //401 unauthorized
            return;
        }
        req.session.userId = row.user_id; //sesijas userid = db userid
        console.log('User is validated!'); // Lietotājs ir verificēts un sesija ir uzsākta
        res.redirect('/');
    });
});

app.get('/logout', (req, res) => { //beigt sesiju
  req.session.destroy((err) => {
    if (err) {
      console.error('logout unsuccessful:', err);
      res.status(500).send('Internal Server Error');
      return;
    }
    res.redirect('/');
  });
});

app.post('/newuser', (req, res) => { //Jauna lietotāja izveidei
    const { username, password, repeatPassword } = req.body;
    if (username.length > 16) { //pārbauda lietotājvarda garumu
        res.status(400).send('Too long username. Please keep to 16 characters or less!');
        return;
    }
    db.get('SELECT 1 FROM Users WHERE username = ?', [username], (err, row) => { //vaicājums datubāzei ievadītam lietotājvārdam
        if (err) {
            console.error('internal server error querying username:', err);
            res.status(500).send('Internal Server Error'); //500 internal server error
            return;
        }
        if (row) { //pārbauda vai lietotājvārds pastāv
            res.status(400).send('Šāds lietotājvārds jau pastāv. Lūdzu, izvēlieties citu lietotājvārdu.');
            return;
        }
        if (isCJKAlphaNumeric(username) == false) { //pārbauda vai lietotājvārdā ievietoti neatļauti simboli
            res.status(400).send('Please only use alphanumeric characters (a-z, A-Z, 0-9) or CJK characters in your username.');
            return;
        } //Username OK, move on
        if (password !== repeatPassword) { //pārbauda vai paroļu laukumi sakrīt
            res.status(400).send('Passwords do not match.');
            return;
        }
        if (isSecure(password) == false) { //pārbauda vai parole pietiekami droša
            res.status(400).send('Password isnt secure enough. Please use at least 6 characters, including an alphanumeric character(a-z, A-Z), number(0-9) and special character(#?!@$%^&-*).');
            return;
        }
        if (isAcceptable(password) == false) { //pārbauda vai parolē ievietoti neatļauti simboli
            res.status(400).send('Password includes forbidden characters. Please limit your password to alphanumeric characters (a-z, A-Z, 0-9) and frequently used special characters(#?!@$%^&-*).');
            return;
        } //Password OK, move on
        const hashedPassword = sha256(password); //hešo paroli pirms ievietošanas datubāzē
        console.log(username, hashedPassword);
        const now = Math.floor(Date.now() / 1000) //unix time in s
        db.run('INSERT INTO Users(username, password, create_time) VALUES(?, ?, ?)', [username, hashedPassword, now], function(err) { //create new row(user) in db
            if (err) {
                console.error('internal server error after creating user:', err);
                res.status(500).send('Internal Server Error'); //500 internal server error
                return;
            }
            console.log('User is created!'); // Log successful account creation attempt
            res.redirect('/signin');
        });
    });
});

app.post('/addword', requireAuth, requireAdmin, (req, res) => {
    const { word, language, meaning, reading } = req.body;
    if (isBlank(word) || isBlank(language) || isBlank(meaning) || isBlank(reading)) { //vai nav tukšumu ar "  "
        res.status(400).send('Please fill in all fields.')
        return;
    }
    db.get('SELECT 1 FROM Words WHERE word = ? AND language = ?', [word, language], (err, row) => {
        if (err) {
            console.error('internal server error querying word:', err);
            res.status(500).send('Internal Server Error'); //500 internal server error
            return;
        }
        if (row) { //pārbauda vai rinda ar šādu numuru jau pastāv
            res.status(400).send('This word already exists in the dictionary.')
            return;
        }
        db.run('INSERT INTO Words(word, language, meaning, reading) VALUES(?, ?, ?, ?)', [word, language, meaning, reading], function(err) {
            if (err) {
                console.error('internal server error after trying to insert word:', err);
                res.status(500).send('Internal Server Error'); //500 internal server error
                return;
            }
            const chars = extractHanCharacters(word); //iziet cauri pårbaudei lai neieiet kana, hangul, etc. tikai kiniesu izcelsmes.
            chars.forEach(char => {
                db.get('SELECT 1 FROM Characters WHERE char = ?', [char], (err, row) => {
                    if (!row) {
                        db.run('INSERT INTO Characters(char) VALUES (?)', [char]);
                    }
                });
            });
            console.log('Word is added!');
            res.redirect('/'); //ielādet lapu atkal, jau ar jaunajiem datiem
        });
    });
});

app.post('/add-to-collection', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { wordId, collectionName } = req.body;

  db.get('SELECT collection_id FROM Collections WHERE name = ? AND user_id = ?', [collectionName, userId], (err, row) => {   // 1. Atrod collection_id nemot vera user_id etc
    if (err || !row) {
      console.error('Collection not found:', err);
      return res.status(400).send('Collection not found');
    }

    const collectionId = row.collection_id;

    const now = Math.floor(Date.now() / 1000)
    db.run('INSERT OR IGNORE INTO CollectionWords (collection_id, word_id, added_time) VALUES (?, ?, ?)', [collectionId, wordId, now], (err) => { //ievieto linkinga tabula
      if (err) {
        console.error('Error adding word to collection:', err);
        return res.status(500).send('Internal Server Error');
      }

      res.status(200).send('Word added to collection!');
    });
  });
});

app.post('/remove-from-collection', requireAuth, (req, res) => {
  const { collectionId, wordId } = req.body;
  const userId = req.session.userId;

  // Safety purposes, lai tikai var nonemt no sava collection
  db.get('SELECT 1 FROM Collections WHERE collection_id = ? AND user_id = ?', [collectionId, userId], (err, row) => {
    if (err || !row) return res.status(403).send('Unauthorized');

    db.run(
      'DELETE FROM CollectionWords WHERE collection_id = ? AND word_id = ?',
      [collectionId, wordId],
      function (err) {
        if (err) {
          console.error('Error removing word from collection:', err);
          return res.status(500).send('Internal Server Error');
        }
        res.sendStatus(200);
      }
    );
  });
});


app.post('/create-and-add', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { name, word_id } = req.body;

  db.get('SELECT collection_id FROM Collections WHERE name = ? AND user_id = ?', [name.trim(), userId], (err, row) => {
    if (err) return res.status(500).send('Error checking existing collection');

    if (row) {
      return res.status(400).send('A collection with that name already exists.');
    }

    const now = Math.floor(Date.now() / 1000)
    db.run('INSERT INTO Collections (user_id, name, create_time) VALUES (?, ?, ?)', [userId, name.trim(), now], function(err) {     // Create new collection
      if (err) return res.status(500).send('Error creating collection');
      const newId = this.lastID;
      const now = Math.floor(Date.now() / 1000);
      db.run('INSERT OR IGNORE INTO CollectionWords (collection_id, word_id, added_time) VALUES (?, ?, ?)', [newId, word_id, now], (err) => {
          if (err) return res.status(500).send('Error adding word');
          res.sendStatus(200);
        }
      );
    });
  });
});

function formatTime(unixTimestamp) {
  const date = new Date(unixTimestamp * 1000); // Convert seconds to ms
  return date.toISOString().split('T')[0]; // Returns format: "YYYY-MM-DD"
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9_\-]/gi, '_'); // Replace invalid characters with _
}

function isBlank(str) { //ievades pārbaude vai tajā ir tikai tukši simboli
    return str.trim().length === 0;
}

function extractHanCharacters(word) {
    const hanRegex = /[\u4E00-\u9FFF]/g; // Basic CJK Unified Ideographs Unicode block
    return [...new Set(word.match(hanRegex) || [])]; // remove duplicates
}

function isCJKAlphaNumeric(input) { //ievades atbilstība zemāk dotam regex, burtciparu simboli
    const hanAlphaNumericRegex = /^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7afa-zA-Z0-9]{2,20}$/; // Basic CJK Unified Ideographs Unicode + Other CJK + ASCII blocks
    return hanAlphaNumericRegex.test(input);
}

function isBlank(str) { //ievades pārbaude vai tajā ir tikai tukši simboli
    return str.trim().length === 0;
}

function isPos(num) { //skaitļa pārbaude vai ir pozitīvs
    return num > 0;
}

function isAcceptable(input) { //ievades atbilstība zemāk dotam regex
    const regex = /^[a-z0-9#?!@$%^&\-*]+$/i; //a-z0-9#?!@$%^&-*
    return regex.test(input);
}

function isSecure(input) { //pārbaude vai parole ir droša
    const regexAlpha = /[a-z]/i;
    const regexNum = /[0-9]/;
    const regexSp = /[#?!@$%^&\-*]/;
    if (input.length >= 6 && regexAlpha.test(input) && regexNum.test(input) && regexSp.test(input)) {
        return true;
    } else {
        return false;
    }
}

function sha256(hashable) { //jaucējparoles izveide
    return crypto.createHash('sha256').update(hashable).digest('hex');
}

app.use((req, res) => {
    res.status(404).send('404 Not Found');
});

app.listen(8080, () => {
    console.log(`Server listening`);
});
