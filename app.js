/* Run this aplication from terminal node app.js, open localhost:3000 to see user interface
REMEMBER! Firts start Redis from ubuntu console: redis-server*/

const express= require('express') //npm install express redis
const path= require('path') //path Node native module to calculate path
const redis = require('redis')//npm install redis
const bcrypt=require('bcrypt') //to hash password npm install bcrypt
const session = require('express-session') //manage user sessions npm install express-session
const client = redis.createClient()
const{promisify}=require('util') //wrap[redis callbacks into async await]
const { formatDistance } = require('date-fns') // npm install date-fns

const app = express()
/*middle ware needed to stoire session data in redis!  npm install connect-redis*/
const RedisStore = require('connect-redis') (session) //npm install connect-redis

app.use(express.urlencoded({ extended: true })) //add a middleware to Express, so it knows it has to process the URL-encoded data sent by the form.

// !!!++DISABLE BACK BUTTON AND CACHE FOR ALL ENDPOINTS!!!!
/*See src@: https://stackoverflow.com/questions/6096492/node-js-and-express-session-handling-back-button-problem*/
app.use(function(req, res, next) {
  res.set('Cache-Control', 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0');
  next();
});


/*==============initialize SESSION============*/
app.use(
    session({
      store: new RedisStore({ client: client }),
      resave: true,
      saveUninitialized: true,
      cookie: {
        maxAge: 36000000, //10 hours, in milliseconds
        httpOnly: false,
        secure: false,//this is falkes for local testing only!!!
      },
      secret: 'bM80SARMxlq4fiWhulfNSeUFURWLTY8vyf',
    })
  )
/*ABOUT  secret:(used to compute the hash) src@ https://stackoverflow.com/questions/5343131/what-is-the-sessions-secret-option*/ 



//=====setup pug as view engine
app.set ('view engine', 'pug')
app.set('views', path.join(__dirname, 'views')) //calculate path to views

/*====ASYNC WITH PROMIOSIFY TO GET DATA FROM REDIS (NO CALLBACS)======*/ 

const ahget = promisify(client.hget).bind(client)
const asmembers = promisify(client.smembers).bind(client)
const ahkeys = promisify(client.hkeys).bind(client)
const aincr = promisify(client.incr).bind(client)
const alrange = promisify(client.lrange).bind(client)


/*==GET FOLLOWED MEMBERS PUT TIME STAMP TO POSTS RENDER TIMELINE TO DASHBOARD==*/ 

app.get('/', async (req, res) => {
  if (req.session.userid) {
    const currentUserName = await ahget(`user:${req.session.userid}`, 'username')
    const following = await asmembers(`following:${currentUserName}`)    
    const users = await ahkeys('users')
    
    const timeline = []
    const posts = await alrange(`timeline:${currentUserName}`, 0, 100)

    for (post of posts) {
      const timestamp = await ahget(`post:${post}`, 'timestamp')
      const timeString = formatDistance(
        new Date(),
        new Date(parseInt(timestamp))
      )

      timeline.push({
        message: await ahget(`post:${post}`, 'message'),
        author: await ahget(`post:${post}`, 'username'),
        timeString: timeString,
      })
    }

    res.render('dashboard', {
      users: users.filter(
        (user) => user !== currentUserName && following.indexOf(user) === -1
      ),
      currentUserName,
      timeline
    })
  } else {
    res.render('login')
  }
})

/*===========RENDER PAGES FOR POST FROM DASHBOARD=========*/ 

app.get('/post', (req, res)=>{
  if (req.session.userid){
      res.render('post')
  }else{
      res.render('login')
  }
  
  })
  
  






/*===========RENDER PAGES FOR LOGIN OR DASHBOARD=========*/ 
app.get('/', (req, res) => {
    if (req.session.userid) {//if user id is ok with password redirect to dashboard of the user
      res.render('dashboard')
    } else {
      res.render('login') //render INDEX=login
    }
  })





/*==========POST MSG ENDPOINT (MSG TO FOLLOWERS , TIMELINE)==========*/ 

  app.post('/post', async (req, res) => {
    if (!req.session.userid) {
      res.render('login')
      return
    }

    const { message } = req.body
    const currentUserName = await ahget(`user:${req.session.userid}`, 'username')
    const postid = await aincr('postid')
    client.hmset(`post:${postid}`, 'userid', req.session.userid, 'username', currentUserName, 'message', message, 'timestamp', Date.now())
    client.lpush(`timeline:${currentUserName}`, postid)
  
    const followers = await asmembers(`followers:${currentUserName}`)
    for (follower of followers) {
      client.lpush(`timeline:${follower}`, postid)
    }
  
    res.redirect('/')
  })





/*===========/FOLLOW ENDPOINT FROM DASHBOARD=========*/ 
app.post('/follow', (req, res) => {
  if (!req.session.userid) {
    res.render('login')
    return
  }

  const { username } = req.body
  //FETCH MESSAGES FROM FOLLOWED USERS
    client.hget(`user:${req.session.userid}`, 'username', (err, currentUserName) => {
    client.sadd(`following:${currentUserName}`, username)
    client.sadd(`followers:${username}`, currentUserName)
  })

  res.redirect('/') //do not render dashboard again, let the endpoint do the data fetching
})




////====POST ENDPOINT AND CHECK USER/PASS=====================

app.post('/', (req, res)=>{
    const {username, password}=req.body
    if(!username ||!password){
        //Remember! error view is only rendered if fields are not set asd required in the pug view!
        res.render('error', {
             message:  'Please set both username and password'
    })
    return
    }




/*==============SAVE SESSION============*/

const saveSessionAndRenderDashboard = userid => {
    req.session.userid = userid
   
	req.session.save()
	res.redirect('/')//redner user dashboard NOTE: changed to redirect/ instead of rendering dashbopard
}





/*==============HANDLE SIGNUP============*/
const handleSignup = (username, password) => {
    //increment userID with each new user
    client.incr('userid', async (err, userid) => {
    client.hset('users', username, userid)
         /*Once the user id is generated store it in the users hash, 
            hash the password and store the hash in Redis, along
            with the username, so we can get a reference to the name 
            if we know the user id:*/ 
    const saltRounds = 10
    //hash the password using bcrypt
    //create password hash
    const hash = await bcrypt.hash(password, saltRounds)
     //store the hash in a Redis set, along with the username
    client.hset(`user:${userid}`, 'hash', hash, 'username', username)
    //after signing up rdirect user to the dashboard and save data
    saveSessionAndRenderDashboard(userid)
    })
    }





/*==============HANDLE LOGIN============*/
const handleLogin = (userid, password) => {
    client.hget(`user:${userid}`, 'hash', async (err, hash) => {
     //compare the hash with the password result will be t/f   
    const result = await bcrypt.compare(password, hash)
    if (result) {
        //if comparison ok redirect to user dashboard
      saveSessionAndRenderDashboard(userid)
    } else {
      res.render('error', {
        message: 'Incorrect password',
      })
      return
    }
    })
    }



/*=======LOGIN OR SIGNUP CASES (defined above)=======*/


  client.hget('users', username, (err, userid)=>{
    if(!userid){
        //user does not exist, singup rpocedure
        handleSignup(username, password)
       
    } else{
        //user exists, login procedure
        handleLogin(userid, password)
        
            }
          })

  })


/*=======HANDLE LOGOUT: [my developments]=======*/


app.post('/logout',(req, res)=>{
  req.session.destroy(function(err) {
    if (req.session) {
      req.session.auth = null;
      res.clearCookie('auth');
      req.session.destroy(function() {});
    }
    console.log('User Logout, Session ended')
  })
  //go to login page
  res.redirect('/') 

})

// listen to port for incoming user actions
app.listen(3000, ()=> console.log('App is listening :)'))