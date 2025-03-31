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

app.get('/worddata', (req, res) => { //lai ienestu visu words(Words) tabulu
    db.all('SELECT * FROM Words ORDER BY word ASC, language ASC', (err, rows) => { //kārto pēc vārda un tad valodu pārredzamībai
        if (err) {
            console.error(err.message);
            return res.status(500).send('Internal Server Error');
        }
        res.json(rows);
    });
});

app.get('/search', (req, res) => {
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
            if (err2) return res.status(500).send('Character search failed');
            res.render('search', {
                query,
                words: wordResults,
                characters: charResults
            });
        });
    });
});

app.get('/user', requireAuth, function (req, res) { //lai ienestu lietotāja datus, kur nepieciešams, sesijas laikā
    const userId = req.session.userId;
    db.get('SELECT username, admin, create_time FROM Users WHERE user_id = ?', [userId], (err, row) => {
        if (err) {
            console.error('internal server error querying ID:', err);
            res.status(500).send('Internal Server Error'); //500 internal server error
            return;
        }
        if (!row) {
            console.log('User not Found');
            res.status(404).send('404 Not Found'); //404 not found
            return;
        }
        console.log('user: success!');
        res.setHeader('Content-Type', 'application/json');
        res.json(row);
    });
});

app.post('/validate', (req, res) => { //Verificēt vai ievadītie dati sakrīt ar kādu no pastāvošiem lietotājiem un uzsāk sesiju
    const username = req.body.username;
    const password = sha256(req.body.password);
    console.log(username, password);
    //console.log(datpix.foo());
    db.get('SELECT * FROM Users WHERE username = ? AND password = ?', [username, password], (err, row) => {
        if (err)  {
            console.error('internal server error after login:', err);
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
    if (username.length > 20) { //pārbauda lietotājvarda garumu
        res.status(400).send('Too long username. Please keep to 20 characters or less!');
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
            res.redirect('/login');
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
