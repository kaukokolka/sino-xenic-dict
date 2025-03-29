const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const app = express();


app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

//./run.sh

const db = new sqlite3.Database('./config/dict.db'); //šeit iestatīt datubāzes lokāciju

app.use('/css', express.static(path.join(__dirname, 'public/css')));

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
 });

 app.get('/test', (req, res) => {
  res.send('It wrok!');
});

 app.get('/worddata', (req, res) => { //lai ienestu visu words(Words) tabulu
     db.all('SELECT * FROM Words ORDER BY word_id ASC', (err, rows) => {
         if (err) {
             console.error(err.message);
             return res.status(500).send('Internal Server Error');
         }
         res.json(rows);
     });
 });

 app.use((req, res) => {
   res.status(404).send('404 Not Found');
});

app.listen(8080, () => {
   console.log(`Server listening`);
});
